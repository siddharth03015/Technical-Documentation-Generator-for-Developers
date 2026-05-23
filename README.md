# Technical-Documentation-Generator-for-Developers

An AI documentation agent that automatically generates and updates technical
documentation from:

- codebase files
- API specification metadata
- pull request change summaries
- deployment change events

## Quick start

Generate markdown documentation from JSON inputs:

```bash
python doc_agent.py \
  --repo /path/to/repo \
  --api-specs /path/to/api_specs.json \
  --pull-requests /path/to/pull_requests.json \
  --deployments /path/to/deployments.json \
  --output /path/to/TECHNICAL_DOCUMENTATION.md
```

All JSON input files are optional; if omitted, the agent still generates the
other available sections and updates the output file.

## Run tests

```bash
python -m unittest discover -s tests -v
```
