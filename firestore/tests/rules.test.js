// Firestore セキュリティルールのテスト。
//
// Firestore へのアクセスはバックエンド（IAM 認可のサーバークライアント。
// ルールの対象外）だけに限定する方針のため、ルールは「クライアント SDK からの
// アクセスを全面拒否」であることを検証する。実行には Firestore エミュレータが
// 必要で、package.json の `npm test` が emulators:exec 経由で起動する。

import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertFails,
  initializeTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  setDoc,
} from 'firebase/firestore';

let testEnv;

beforeAll(async () => {
  // emulators:exec 実行中は FIRESTORE_EMULATOR_HOST が設定される。
  // 手動でエミュレータを立てた場合に備えて既定値も持つ。
  const [host, port] = (
    process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8081'
  ).split(':');
  testEnv = await initializeTestEnvironment({
    projectId: 'demo-portal',
    firestore: {
      rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8'),
      host,
      port: Number(port),
    },
  });
});

afterAll(async () => {
  await testEnv?.cleanup();
});

// バックエンド相当（ルールを迂回する特権コンテキスト）で設定を作っておき、
// 「実データが存在してもクライアントからは読めない」ことを確かめる。
async function seedToolSettings() {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), 'tool_settings', 'excel-report-formatter'), {
      template_folder_id: 'folder-1',
      template_file_name: '雛形.xlsx',
    });
  });
}

describe('未認証クライアント', () => {
  it('tool_settings を読めない', async () => {
    await seedToolSettings();
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(db, 'tool_settings', 'excel-report-formatter')));
    await assertFails(getDocs(collection(db, 'tool_settings')));
  });

  it('tool_settings に書き込めない', async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(
      setDoc(doc(db, 'tool_settings', 'excel-report-formatter'), {
        template_folder_id: 'evil',
      })
    );
  });
});

describe('認証済みクライアント（社内ユーザー相当のトークン）', () => {
  const authed = () =>
    testEnv
      .authenticatedContext('user_123', { email: 'tester@example.co.jp' })
      .firestore();

  it('tool_settings を読めない（設定へのアクセスはバックエンド API 経由のみ）', async () => {
    await seedToolSettings();
    await assertFails(getDoc(doc(authed(), 'tool_settings', 'excel-report-formatter')));
  });

  it('tool_settings を書き換え・削除できない', async () => {
    await seedToolSettings();
    const ref = doc(authed(), 'tool_settings', 'excel-report-formatter');
    await assertFails(setDoc(ref, { template_folder_id: 'hijacked' }));
    await assertFails(deleteDoc(ref));
  });

  it('その他の任意のコレクションにもアクセスできない（既定 deny）', async () => {
    const db = authed();
    await assertFails(getDoc(doc(db, 'anything', 'else')));
    await assertFails(setDoc(doc(db, 'anything', 'else'), { a: 1 }));
  });
});
