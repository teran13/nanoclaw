# Remove Vercel

Every step is idempotent — safe to re-run. Steps delete the files and config the apply created.

## 1. Remove the container skill

`container/skills/` is a read-only mount; the per-group `.claude-shared/skills/` symlink to it is pruned automatically on the next spawn:

```bash
rm -rf container/skills/vercel-cli
```

## 2. Remove the dependency guard test

```bash
rm -f src/vercel-manifest.test.ts
```

## 3. Remove the OneCLI credential

Delete the Vercel secret and strip its id from every agent's assigned list. `set-secrets` replaces the whole list, so read, filter, and write back per agent:

```bash
VERCEL_SECRET_ID=$(onecli secrets list | jq -r '.data[] | select(.name | test("(?i)vercel")) | .id' | head -1)
if [ -n "$VERCEL_SECRET_ID" ]; then
  for agent in $(onecli agents list | jq -r '.data[].id'); do
    REMAINING=$(onecli agents secrets --id "$agent" | jq -r --arg id "$VERCEL_SECRET_ID" '[.data[] | select(. != $id)] | join(",")')
    onecli agents set-secrets --id "$agent" --secret-ids "$REMAINING"
  done
  onecli secrets delete --id "$VERCEL_SECRET_ID"
fi
```

## 4. The Vercel CLI in the container image

Remove the `vercel` entry from `container/cli-tools.json` — this skill added it, and it is
not part of the base image. Then `./container/build.sh` so the image matches the manifest.

## 5. Restart the agents

So sessions stop loading the removed `vercel-cli` skill — each group comes back on its next message:

```bash
ncl groups list --json | jq -r '.data[].id' | while read -r gid; do ncl groups restart --id "$gid"; done
```
