# Ask User Workflow Example

A simple workflow demonstrating the `ask_user` pause/resume mechanism.

## Workflow Definition

```yaml
name: ask-user-example
version: "1.0"
description: |
  A simple workflow demonstrating the ask_user pause/resume mechanism.
  This workflow pauses at a confirmation step and waits for user response before continuing.

nodes:
  # Step 1: Initialize - set the initial context
  - id: init
    type: tool
    config:
      tool: echo
      params:
        message: "Starting workflow execution..."
    depends_on: []

  # Step 2: Show the action to be confirmed
  - id: show_action
    type: tool
    config:
      tool: echo
      params:
        message: "Action: Deploy to production environment"
    depends_on:
      - init

  # Step 3: Ask user for confirmation (this will PAUSE the workflow)
  - id: confirm_deploy
    type: ask_user
    config:
      query: "Are you sure you want to deploy to production?"
      options:
        - "Yes, deploy now"
        - "No, cancel"
      required_confirm: true

  # Step 4: Process the response
  - id: process_response
    type: tool
    config:
      tool: echo
      params:
        message: "User response received: ${confirm_deploy.response}"
    depends_on:
      - confirm_deploy

  # Step 5: Show final result
  - id: finalize
    type: tool
    config:
      tool: echo
      params:
        message: "Workflow completed successfully!"
    depends_on:
      - process_response

entry: [init]

config:
  parallel_limit: 1
  timeout: 60000
```

## Usage

### Run the workflow

```bash
# From file (auto-registers to workflows table)
roy workflow run ask-user-example.yaml --file

# From registered workflow
roy workflow run ask-user-example
```

### View paused workflow

```bash
# List workflow sessions
roy sessions list --type workflow

# Get session details
roy sessions get workflow_xxx

# View pending question
roy sessions messages workflow_xxx --role workflow.node.interrupt
```

### Resume with response

```bash
# Resume with response
roy workflow resume workflow_xxx --response "Yes, deploy now"

# Or from file
roy workflow resume workflow_xxx -r "Yes, deploy now"
```

## Execution Flow

```
┌─────────────────────────────────────────────────────────────┐
│ 1. Workflow starts                                         │
│    └── init → show_action → confirm_deploy                │
│                                                             │
│ 2. confirm_deploy node executes                            │
│    └── ask_user config:                                    │
│        query: "Are you sure you want to deploy?"         │
│        options: ["Yes, deploy now", "No, cancel"]         │
│                                                             │
│ 3. AskUserNode throws AskUserError                         │
│    └── Workflow pauses, status = 'paused'                  │
│    └── Session stores workflow.node.interrupt message      │
│                                                             │
│ 4. User resumes with response                              │
│    └── roy workflow resume workflow_xxx -r "Yes, deploy now"│
│                                                             │
│ 5. Workflow continues                                       │
│    └── process_response → finalize                        │
│                                                             │
│ 6. Workflow completes                                      │
│    └── status = 'completed'                               │
└─────────────────────────────────────────────────────────────┘
```

## Session Messages

During execution, the session will contain these messages:

```
1. [workflow.node.call]    init started
2. [workflow.node.result] init completed
3. [workflow.node.call]    show_action started
4. [workflow.node.result] show_action completed
5. [workflow.node.call]    confirm_deploy started
6. [workflow.node.interrupt] confirm_deploy asks user
   └── query: "Are you sure you want to deploy to production?"
7. [workflow.node.resume] user responds: "Yes, deploy now"
8. [workflow.node.result] confirm_deploy completed
9. [workflow.node.call]    process_response started
10. [workflow.node.result] process_response completed
11. [workflow.node.call]    finalize started
12. [workflow.node.result] finalize completed
```

## API Usage

```typescript
import { WorkflowEngine } from '@ai-setting/roy-bot-core';

// Create engine
const engine = await WorkflowEngine.create({
  sessionComponent,
  toolRegistry,
  // ...
});

// Run workflow
const sessionId = await engine.createSession('ask-user-example');
await engine.run(sessionId);

// Later, resume
const result = await engine.resume(sessionId, {
  response: 'Yes, deploy now'
});
```
