# CloudStudio deployment contract

This slice runs the global AgentTeams Manager, the fixed Team Leader, and all four domain Workers on the same DSH runtime image. The Manager owns Controller-level Worker/Team administration; the Team Leader owns Project/DAG coordination through TeamHarness. They remain separate identities and authority planes.

## Required build order

1. Check out `agentscope-ai/AgentTeams` at tag `v1.2.3` / commit `223ddc2b8073e4c8b93bcbb15e1d717f196c04d9`.
2. Run `npm run patch:agentteams-worker -- --source <checkout>` from this package.
3. Build and test the patched AgentTeams Controller in CloudStudio. Go tests are a hard gate.
4. Build this directory's Dockerfile as `juchang/agentteams-dsh-runtime:0.4.1`.
5. Deploy AgentTeams with `cloudstudio-values.yaml`, ensuring the patched Controller image is selected.
6. Apply `manager-dsh.yaml` only when Helm did not create the Manager, then apply `agentteams-v1.2.3-dsh.yaml`.
7. Read back the Manager, all five Workers, the Team roster, every projected `runtime.yaml`, and all six runtime readiness markers.

CloudStudio can run the checked-in scripts directly:

```bash
export AGENTTEAMS_SOURCE=/workspace/AgentTeams
bash deploy/cloudstudio-build-and-verify.sh
JUCHANG_CONFIRM_DEPLOY=1 bash deploy/cloudstudio-deploy.sh
```

The deploy script refuses to write unless `JUCHANG_CONFIRM_DEPLOY=1` is present.

When `0.3.1` is already present on the CloudStudio host, the checked-in
`deploy/Dockerfile.runtime-overlay` reuses its verified DSH, Python and
TeamHarness layers and replaces only the locked Node dependencies and runtime
source. The resulting `0.4.1` image has the same entrypoint and authority
boundary as the full build; use the full Dockerfile for a clean-room release.

An existing all-in-one CloudStudio installation can keep its current network, ports, state volume, and manager filesystem while replacing only the embedded Controller image:

```bash
JUCHANG_CONFIRM_UPGRADE=1 bash deploy/cloudstudio-upgrade-embedded.sh
```

The previous Controller remains stopped as `agentteams-controller-v122-backup`. The script restores it automatically when the new `/healthz` does not become ready within two minutes.

For a real Manager-room smoke test, copy `cloudstudio-matrix-message.sh` into the embedded Controller and run it there with a Manager room ID and one Admin message. It logs in from the Controller's existing environment, waits for a new `MANAGER_*` response, logs out, and never prints the access token or password.

`step-3.5-flash-2603` is the verified CloudStudio route used by the checked-in manifests. Replace only the model ID when another authorized AgentTeams Gateway route is verified; do not change the DSH runtime or authority boundary.

## Non-claims

- A manifest or image build is not a live runtime proof.
- A DSH receipt is not an accepted AgentTeams Task.
- `PROJECT_COMPLETED` means the audited collaboration run completed and is ready for named human review; it is not approval, publication, refund, or production execution.
- Manager mutations require an expiring plan and exact Admin confirmation. Destructive plans additionally require the `DELETE` suffix. A plan preview is not proof that Controller state changed.
