// Firestore セキュリティルールのテスト。
//
// Firestore へのアクセスはバックエンド（IAM 認可のサーバークライアント。
// ルールの対象外）だけに限定する方針のため、ルールは「クライアント SDK からの
// アクセスを全面拒否」であることを検証する。実行には Firestore エミュレータが
// 必要で、package.json の `npm test` が emulators:exec 経由で起動する。
//
// 共有設定はチャンネル（本番 / 開発 / PR プレビュー）ごとにネストしたパスへ
// 保存するため、ルートだけでなくネストしたパスも拒否されることを確認する。

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

// バックエンドが実際に読み書きするパス（config.settings_root() と対応）。
const PRODUCTION = ['static-channels', 'production', 'tool_settings'];
const DEVELOPMENT = ['static-channels', 'development', 'tool_settings'];
const PREVIEW = ['preview-channels', 'pr-123', 'tool_settings'];
const TOOL = 'excel-report-formatter';

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
    for (const root of [PRODUCTION, DEVELOPMENT, PREVIEW]) {
      await setDoc(doc(context.firestore(), ...root, TOOL), {
        template_folder_id: 'folder-1',
        template_file_name: '雛形.xlsx',
      });
    }
  });
}

describe('未認証クライアント', () => {
  it('どのチャンネルの共有設定も読めない', async () => {
    await seedToolSettings();
    const db = testEnv.unauthenticatedContext().firestore();
    for (const root of [PRODUCTION, DEVELOPMENT, PREVIEW]) {
      await assertFails(getDoc(doc(db, ...root, TOOL)));
      await assertFails(getDocs(collection(db, ...root)));
    }
  });

  it('どのチャンネルの共有設定にも書き込めない', async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    for (const root of [PRODUCTION, DEVELOPMENT, PREVIEW]) {
      await assertFails(
        setDoc(doc(db, ...root, TOOL), { template_folder_id: 'evil' })
      );
    }
  });
});

describe('認証済みクライアント（社内ユーザー相当のトークン）', () => {
  const authed = () =>
    testEnv
      .authenticatedContext('user_123', { email: 'tester@example.co.jp' })
      .firestore();

  it('本番チャンネルの設定を読めない（設定へのアクセスはバックエンド API 経由のみ）', async () => {
    await seedToolSettings();
    await assertFails(getDoc(doc(authed(), ...PRODUCTION, TOOL)));
  });

  it('本番チャンネルの設定を書き換え・削除できない', async () => {
    await seedToolSettings();
    const ref = doc(authed(), ...PRODUCTION, TOOL);
    await assertFails(setDoc(ref, { template_folder_id: 'hijacked' }));
    await assertFails(deleteDoc(ref));
  });

  it('プレビューチャンネルを経由して本番へ回り込むこともできない', async () => {
    await seedToolSettings();
    const db = authed();
    // チャンネルを束ねる親コレクション自体も列挙できない。
    await assertFails(getDocs(collection(db, 'preview-channels')));
    await assertFails(getDocs(collection(db, 'static-channels')));
    await assertFails(setDoc(doc(db, ...PREVIEW, TOOL), { a: 1 }));
  });

  it('その他の任意のコレクションにもアクセスできない（既定 deny）', async () => {
    const db = authed();
    await assertFails(getDoc(doc(db, 'anything', 'else')));
    await assertFails(setDoc(doc(db, 'anything', 'else'), { a: 1 }));
  });
});
