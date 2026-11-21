# KeelVault

Foundry project for the on-chain trading guard. Tests use forge-std, which is not committed.

```bash
./install-forge-std.sh
forge test --offline
```

`install-forge-std.sh` clones forge-std v1.17.0 and removes its git metadata so Forge does not replace it. The vault source does not import OpenZeppelin.
