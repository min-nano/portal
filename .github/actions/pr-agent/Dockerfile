# PR-Agent 本体（.github/workflows/pr-agent.yml から使う）。
#
# 公式の action（qodo-ai/pr-agent）は中身が `FROM pragent/pr-agent:github_action`
# の 1 行で、実行のたびにその時点の最新イメージを取ってくる。action を commit
# SHA で固定しても、動く版は固定されない。そこで同じことを版と digest を固定して
# 書き、Dependabot（docker）に tag と digest を一緒に上げさせる。
FROM pragent/pr-agent:0.48.0-github_action@sha256:80edef71baa3df28c129d858d4b53784abfc14704c235efb32b6c461d5399a6d
