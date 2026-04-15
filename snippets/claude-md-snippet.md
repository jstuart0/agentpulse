## AgentPulse Status Reporting

When working on tasks in this project, periodically report your status to AgentPulse
by running the following command after completing significant steps or changing tasks.
Do this approximately every 3-5 tool uses, or when switching to a new subtask.

```bash
curl -s -X POST "${AGENTPULSE_URL:-http://localhost:3000}/api/v1/hooks/status" \
  -H "Authorization: Bearer ${AGENTPULSE_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "session_id": "'"$CLAUDE_SESSION_ID"'",
    "status": "<one of: researching|implementing|testing|debugging|reviewing|documenting|planning|waiting>",
    "task": "<one-line description of current task>",
    "plan": ["<completed step 1>", "<completed step 2>", ">> <current step>", "<pending step>"]
  }'
```

Use ">>" prefix for the current step in the plan array. Keep status updates concise.
Do NOT block on the curl response -- use it as a fire-and-forget status ping.
