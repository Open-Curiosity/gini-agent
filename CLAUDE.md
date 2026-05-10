# Runtime logs

Gini captures every spawned child's stdio into log files under
`~/.gini/instances/<instance>/logs/`. The instance is the workspace
directory basename (e.g. `rabat` for this workspace). All files are
appended to (not truncated) so logs survive restarts.

| File                  | Contents                                                                 |
| --------------------- | ------------------------------------------------------------------------ |
| `web.log`             | Next.js dev server stdout + stderr (control-plane UI)                    |
| `runtime-stdout.log`  | Gini runtime server stdout + stderr (the Bun process behind the API)     |
| `runtime.jsonl`       | Structured gini runtime events (e.g. `runtime.started`); separate stream |

To read recent output:

```bash
INSTANCE=$(basename $(pwd))
tail -n 200 ~/.gini/instances/$INSTANCE/logs/web.log
tail -n 200 ~/.gini/instances/$INSTANCE/logs/runtime-stdout.log
tail -n 200 ~/.gini/instances/$INSTANCE/logs/runtime.jsonl
```

# Tmux session

`bun run gini run` is launched inside a tmux session named `gini-<instance>`
(e.g. `gini-rabat`) so the user can watch the live process and the agent
can restart it without disturbing what the user sees in their terminal.

```bash
SESSION=gini-$(basename $(pwd))
tmux capture-pane -t $SESSION -p -S -2000   # read what's currently in the pane
tmux send-keys -t $SESSION C-c              # stop the running app (gini run will exit)
tmux send-keys -t $SESSION "bun run gini run --instance $(basename $(pwd))" Enter   # restart
```

If `tmux has-session -t gini-<instance>` returns non-zero, the run script
hasn't been started yet — ask the user to start it from Conductor rather
than starting it yourself. Prefer reading the log files above for
historical output; use `capture-pane` only when you need exactly what's
on screen right now.
