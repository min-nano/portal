# CLAUDE.md

設計とその理由は README.md にまとめてある。挙動を変えたら README も合わせて直す。

## PR の運用

- **PR は必ず下書き（draft）で作る。** 自動レビュー（`.github/workflows/tests.yml` の `review`
  ジョブ）は、Ready for review への切り替え時に PR 全体を、その後は Ready の PR への push の
  たびに差分を見るため、作業途中で Ready にしない。
- Ready for review への切り替えは、案がまとまった時点で人が行う。頼まれない限り自分で切り替えない。
