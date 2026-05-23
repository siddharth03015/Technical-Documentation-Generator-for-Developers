from __future__ import annotations

import argparse
import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


@dataclass
class DocumentationSignals:
    codebase: dict[str, Any] = field(default_factory=dict)
    apis: list[dict[str, Any]] = field(default_factory=list)
    pull_requests: list[dict[str, Any]] = field(default_factory=list)
    deployments: list[dict[str, Any]] = field(default_factory=list)


class TechnicalDocumentationAgent:
    def collect_codebase_signals(self, repo_path: str | Path) -> dict[str, Any]:
        root = Path(repo_path)
        if not root.exists():
            return {"file_count": 0, "languages": {}}

        file_count = 0
        extensions: dict[str, int] = {}
        for path in root.rglob("*"):
            if (
                path.is_file()
                and ".git" not in path.parts
                and "__pycache__" not in path.parts
                and not any(part.startswith(".") for part in path.parts if part not in {".", ".."})
            ):
                file_count += 1
                ext = path.suffix.lower() or "no_extension"
                extensions[ext] = extensions.get(ext, 0) + 1
        return {"file_count": file_count, "languages": extensions}

    def load_json_list(self, source_path: str | Path | None) -> list[dict[str, Any]]:
        if not source_path:
            return []
        path = Path(source_path)
        if not path.exists():
            return []

        raw = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(raw, list):
            return [item for item in raw if isinstance(item, dict)]
        if isinstance(raw, dict):
            return [raw]
        return []

    def collect_signals(
        self,
        repo_path: str | Path,
        api_specs_path: str | Path | None = None,
        pull_requests_path: str | Path | None = None,
        deployments_path: str | Path | None = None,
    ) -> DocumentationSignals:
        return DocumentationSignals(
            codebase=self.collect_codebase_signals(repo_path),
            apis=self.load_json_list(api_specs_path),
            pull_requests=self.load_json_list(pull_requests_path),
            deployments=self.load_json_list(deployments_path),
        )

    def generate_documentation(self, signals: DocumentationSignals) -> str:
        generated_at = datetime.now(timezone.utc).isoformat()
        lines = [
            "# Technical Documentation",
            "",
            f"_Last generated: {generated_at}_",
            "",
            "## Codebase Overview",
            f"- Total files indexed: {signals.codebase.get('file_count', 0)}",
            "- File type distribution:",
        ]

        languages = signals.codebase.get("languages", {})
        if languages:
            for ext, count in sorted(languages.items()):
                lines.append(f"  - `{ext}`: {count}")
        else:
            lines.append("  - No files found")

        lines.extend(
            [
                "",
                "## API Changes",
                f"- API entries observed: {len(signals.apis)}",
            ]
        )
        for api in signals.apis[:10]:
            name = api.get("name") or api.get("id") or "unknown-api"
            version = api.get("version", "unspecified")
            lines.append(f"  - {name} (version: {version})")

        lines.extend(
            [
                "",
                "## Pull Request Updates",
                f"- Pull requests included: {len(signals.pull_requests)}",
            ]
        )
        for pr in signals.pull_requests[:10]:
            number = pr.get("number", "n/a")
            title = pr.get("title", "Untitled PR")
            lines.append(f"  - PR #{number}: {title}")

        lines.extend(
            [
                "",
                "## Deployment Changes",
                f"- Deployment events included: {len(signals.deployments)}",
            ]
        )
        for deployment in signals.deployments[:10]:
            environment = deployment.get("environment", "unknown")
            version = deployment.get("version", "unspecified")
            status = deployment.get("status", "unknown")
            lines.append(f"  - {environment}: {version} ({status})")

        lines.append("")
        return "\n".join(lines)

    def update_documentation(self, output_path: str | Path, content: str) -> Path:
        out = Path(output_path)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(content, encoding="utf-8")
        return out


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate technical documentation from code and change signals."
    )
    parser.add_argument("--repo", required=True, help="Path to the repository root")
    parser.add_argument("--api-specs", help="Path to API metadata JSON file")
    parser.add_argument("--pull-requests", help="Path to pull request metadata JSON file")
    parser.add_argument("--deployments", help="Path to deployment metadata JSON file")
    parser.add_argument(
        "--output",
        default="TECHNICAL_DOCUMENTATION.md",
        help="Path to output markdown file",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    agent = TechnicalDocumentationAgent()
    signals = agent.collect_signals(
        repo_path=args.repo,
        api_specs_path=args.api_specs,
        pull_requests_path=args.pull_requests,
        deployments_path=args.deployments,
    )
    documentation = agent.generate_documentation(signals)
    agent.update_documentation(args.output, documentation)
    print(f"Documentation written to {args.output}")


if __name__ == "__main__":
    main()
