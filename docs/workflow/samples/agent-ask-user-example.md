# Agent Ask User Workflow Example

A workflow demonstrating `ask_user` within an AgentNode. The agent can call the `ask_user` tool during its ReAct loop, causing the workflow to pause.

## Workflow Definition

```yaml
name: agent-ask-user-example
version: "1.0"
description: |
  A workflow demonstrating ask_user within an AgentNode.
  The agent can call ask_user tool during its ReAct loop, causing the workflow to pause.

nodes:
  # Step 1: Initialize context
  - id: setup
    type: tool
    config:
      tool: echo
      params:
        message: "Setting up deployment context..."
    depends_on: []

  # Step 2: Agent with ask_user capability
  - id: deployment_agent
    type: agent
    config:
      agent: general
      prompt: |
        You are a deployment assistant. Your task is to deploy an application.
        
        Steps:
        1. Check the current environment
        2. Prepare deployment configuration
        3. ASK USER for confirmation before deploying to production
           Use the ask_user tool with query: "Confirm production deployment"
        4. Execute deployment (echo result)
        
        Be careful with production deployments - always ask for confirmation!
    params:
      input: "production"
    depends_on:
      - setup

  # Step 3: Show deployment result
  - id: report
    type: tool
    config:
      tool: echo
      params:
        message: "Deployment task completed."
    depends_on:
      - deployment_agent

entry: [setup]
```

## Key Differences from Simple AskUserNode

| Aspect | AskUserNode | AgentNode with ask_user |
|--------|-------------|------------------------|
| Trigger | Configured in workflow YAML | Agent decides when to call |
| Flexibility | Fixed at design time | Dynamic based on agent reasoning |
| Use Case | Simple confirmations | Complex decision-making |
| Sub-session | Not applicable | Agent runs in its own session |

## How It Works

```
┌─────────────────────────────────────────────────────────────┐
│ 1. Workflow starts                                          │
│    └── setup → deployment_agent                            │
│                                                              │
│ 2. AgentNode creates sub-session                            │
│    └── session ID: agent_deployment_agent_xxx               │
│                                                              │
│ 3. Agent executes ReAct loop                                │
│    └── Think → Tool → Think → Tool → ...                  │
│                                                              │
│ 4. Agent calls ask_user tool                                │
│    └── Tool: ask_user                                      │
│        Query: "Confirm production deployment"               │
│                                                              │
│ 5. AskUserError thrown                                      │
│    └── Contains agentSessionId                             │
│                                                              │
│ 6. Executor writes interrupt message                        │
│    └── metadata.agentSessionId = agent_deployment_agent_xxx │
│                                                              │
│ 7. Workflow pauses                                          │
│    └── Main session status = 'paused'                       │
│    └── Agent sub-session status = 'paused'                 │
└─────────────────────────────────────────────────────────────┘
```

## Session Structure

### Main Workflow Session

```
Session: workflow_abc123
└── metadata:
    ├── type: 'workflow'
    ├── workflowName: 'agent-ask-user-example'
    └── agentSessions:
        - nodeId: 'deployment_agent'
          sessionId: 'agent_deployment_agent_xxx'
          status: 'paused'
```

### Agent Sub-session

```
Session: agent_deployment_agent_xxx
└── metadata:
    ├── parentSessionId: 'workflow_abc123'
    └── nodeId: 'deployment_agent'
```

## Resume Flow

```bash
# View paused workflow
roy sessions get workflow_abc123
# Output shows:
#   - Main session: status='paused'
#   - Agent sub-session: deployment_agent → agent_deployment_agent_xxx (paused)

# Resume with response
roy workflow resume workflow_abc123 --response "Confirmed, proceed with deployment"

# Resume process:
# 1. Add user response to main session (workflow.node.resume)
# 2. Add user response to agent sub-session (user message)
# 3. Resume agent loop with new context
# 4. Agent continues execution
# 5. When agent completes, main workflow continues
```

## Message Flow

```
Main Session (workflow_abc123):
1. [workflow.node.call]    setup started
2. [workflow.node.result] setup completed
3. [workflow.node.call]    deployment_agent started
4. [workflow.node.interrupt] deployment_agent asks user
   └── agentSessionId: agent_deployment_agent_xxx

Agent Sub-session (agent_deployment_agent_xxx):
1. [user] Check environment...
2. [assistant] I'll check the environment first.
3. [tool] env_check result: production
4. [user] Prepare config...
5. [assistant] I'll prepare the deployment configuration.
6. [tool] ask_user: "Confirm production deployment"
7. [user] (paused - waiting for resume)

After resume:
8. [user] Confirmed, proceed with deployment
9. [assistant] Deploying...
10. [tool] deploy result: success
11. [assistant] Deployment completed successfully.
```

## Benefits of Agent-based Ask User

1. **Dynamic Decision Making**: Agent can decide when to ask based on context
2. **Complex Reasoning**: Agent can gather information before asking
3. **Rich Context**: Agent can explain why it needs confirmation
4. **Conditional Flows**: Agent can skip or modify questions based on conditions
