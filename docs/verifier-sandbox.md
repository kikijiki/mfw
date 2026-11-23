# Verifier sandbox

A definition-of-done check runs the candidate's code. mfw runs it in a
disposable clone of one commit, inside the attested `verifier` or `merge-verify`
sandbox role. The check has no network, no credentials and no ambient
environment, and its clone holds that commit's files with no project history.

## What runs where

| Check | Where it runs |
| --- | --- |
| A clone run's checks | Verifier sandbox |
| An autonomous worktree run left from an older version | Verifier sandbox, run on the run's committed tip |
| The merge queue's re-check and merge-commit check | `merge-verify` sandbox |
| The regression sweep and its corroboration rerun | `merge-verify` sandbox |
| Armed reopen commands | `merge-verify` sandbox |
| An interactive worktree run's checks | The host, because a person approved the run |

A check that cannot run in the sandbox is reported as an infrastructure result.
It is never retried on the host.

## Limits on a check

- **Disk:** set `checkMaxTreeMb` in the project's entry in
  `$MFW_HOME/config.json`. The default is `20480` (20 GiB). The host measures the
  tree every two seconds and stops the check when it passes the limit, so a fast
  writer can exceed it by what it writes in one interval. A check that makes part
  of its tree unreadable to the measurement is stopped too.
- **Tasks and memory:** limited by the systemd scope of the sandbox.
- **Time:** the check's `timeout`, 10 minutes by default.

## Dependencies

The clone holds tracked files only. Until the sandbox can supply a project's dev
shell and installed dependencies, a check that fails in a tree with a
`package.json` and no `node_modules`, or that exits 126 or 127, is reported as
infrastructure rather than as a failure of the code.
