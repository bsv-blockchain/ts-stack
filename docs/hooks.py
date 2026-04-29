"""
MkDocs hook — auto-generates AsyncAPI HTML visualizations before each build.

Runs `node scripts/generate-asyncapi-html.mjs` so that
docs/assets/asyncapi/<spec>/index.html files are always up to date.

To skip generation (e.g. in CI where files are pre-built), set:
    SKIP_ASYNCAPI_GEN=1 mkdocs build
"""
import os
import subprocess


def on_pre_build(config, **kwargs):
    if os.environ.get("SKIP_ASYNCAPI_GEN"):
        print("mkdocs hook: skipping AsyncAPI HTML generation (SKIP_ASYNCAPI_GEN set)")
        return

    script = os.path.join(os.path.dirname(__file__), "..", "scripts", "generate-asyncapi-html.mjs")
    script = os.path.normpath(script)

    if not os.path.exists(script):
        print(f"mkdocs hook: script not found, skipping — {script}")
        return

    print("mkdocs hook: generating AsyncAPI HTML visualizations …")
    result = subprocess.run(
        ["node", script],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        print("mkdocs hook: AsyncAPI generation failed (non-fatal, continuing build)")
        print(result.stderr[:2000] if result.stderr else "(no stderr)")
    else:
        print("mkdocs hook: AsyncAPI HTML generation complete.")
