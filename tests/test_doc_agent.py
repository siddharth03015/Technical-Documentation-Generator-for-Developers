import json
import tempfile
import unittest
from pathlib import Path

from doc_agent import TechnicalDocumentationAgent


class TechnicalDocumentationAgentTests(unittest.TestCase):
    def setUp(self) -> None:
        self.agent = TechnicalDocumentationAgent()
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)

        (self.root / "src").mkdir()
        (self.root / "src" / "app.py").write_text("print('hello')\n", encoding="utf-8")
        (self.root / "README.md").write_text("# Demo\n", encoding="utf-8")

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_collect_signals_includes_all_sources(self) -> None:
        api_file = self.root / "apis.json"
        pr_file = self.root / "prs.json"
        deploy_file = self.root / "deployments.json"

        api_file.write_text(
            json.dumps([{"name": "users-api", "version": "v1"}]), encoding="utf-8"
        )
        pr_file.write_text(
            json.dumps([{"number": 42, "title": "Add auth endpoint"}]), encoding="utf-8"
        )
        deploy_file.write_text(
            json.dumps([{"environment": "prod", "version": "1.2.3", "status": "success"}]),
            encoding="utf-8",
        )

        signals = self.agent.collect_signals(
            repo_path=self.root,
            api_specs_path=api_file,
            pull_requests_path=pr_file,
            deployments_path=deploy_file,
        )

        self.assertGreaterEqual(signals.codebase["file_count"], 2)
        self.assertEqual(signals.apis[0]["name"], "users-api")
        self.assertEqual(signals.pull_requests[0]["number"], 42)
        self.assertEqual(signals.deployments[0]["environment"], "prod")

    def test_generate_and_update_documentation(self) -> None:
        signals = self.agent.collect_signals(repo_path=self.root)
        content = self.agent.generate_documentation(signals)

        self.assertIn("## Codebase Overview", content)
        self.assertIn("## API Changes", content)
        self.assertIn("## Pull Request Updates", content)
        self.assertIn("## Deployment Changes", content)

        output_file = self.root / "docs" / "TECHNICAL_DOCUMENTATION.md"
        self.agent.update_documentation(output_file, content)
        saved = output_file.read_text(encoding="utf-8")
        self.assertEqual(saved, content)


if __name__ == "__main__":
    unittest.main()
