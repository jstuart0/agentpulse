## AgentPulse Status Reporting

Report status to AgentPulse periodically during work (every 3-5 tool uses):

```bash
curl -s -X POST "${AGENTPULSE_URL:-http://localhost:3000}/api/v1/hooks/status" \
  -H "Authorization: Bearer ${AGENTPULSE_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"session_id": "'"$CODEX_SESSION_ID"'", "status": "<researching|implementing|testing|debugging|planning>", "task": "<current task>", "plan": ["done step", ">> current step", "pending step"]}'
```
