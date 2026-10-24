# CLAUDE.md

設計とその理由は README.md にまとめてある。挙動を変えたら README も合わせて直す。

## PR の運用

- **PR は必ず下書き（draft）で作る。** 自動レビュー（`.github/workflows/claude-review.yml`）は
  Ready for review への切り替え時に 1 回だけ走るため、作業途中で Ready にしない。
- Ready for review への切り替えは、案がまとまった時点で人が行う。頼まれない限り自分で切り替えない。
- 再レビューは PR に `@claude` でコメントして依頼する（`.github/workflows/claude.yml`）。
