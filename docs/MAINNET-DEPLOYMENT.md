# Live Arc mainnet deployment

Chain 5042; production receipts checked on 2026-10-14. Testnet records are retained separately.

| Contract | Mainnet address |
|---|---|
| XorvCcipReceiver | [0xE4de2F7828d580954f8Ea36713Cf40766b37eDe1](https://explorer.arc.io/address/0xE4de2F7828d580954f8Ea36713Cf40766b37eDe1) |
| XorvEscrow | [0x6EF98A57FC25e237d25CB59B5F24a964E07e6412](https://explorer.arc.io/address/0x6EF98A57FC25e237d25CB59B5F24a964E07e6412) |
| XorvLedger | [0xc9980A3A07A6CBBfc528cf10ccf3285EF0978c3f](https://explorer.arc.io/address/0xc9980A3A07A6CBBfc528cf10ccf3285EF0978c3f) |
| XorvReputation | [0x1C2c20852A68b92ed7d95DD372575eD99728158F](https://explorer.arc.io/address/0x1C2c20852A68b92ed7d95DD372575eD99728158F) |

## Transactions

- CREATE XorvLedger : [0x68fd2e2eb8e553a7d69f120abd17478d763b69f1879dab1869a149dac39a1a4e](https://explorer.arc.io/tx/0x68fd2e2eb8e553a7d69f120abd17478d763b69f1879dab1869a149dac39a1a4e); status 1; gas 0.0412294050 USDC.
- CREATE XorvReputation : [0xed9c3412b2e9ec9ea88ff6f07fc7af0a5431ef2b96d237bb65a03068d8f2c782](https://explorer.arc.io/tx/0xed9c3412b2e9ec9ea88ff6f07fc7af0a5431ef2b96d237bb65a03068d8f2c782); status 1; gas 0.0245528220 USDC.
- CREATE XorvEscrow : [0x923e38254bfe3f8a89867014b0f50cad88d8b51648310747344bf40ee4065915](https://explorer.arc.io/tx/0x923e38254bfe3f8a89867014b0f50cad88d8b51648310747344bf40ee4065915); status 1; gas 0.0551495700 USDC.
- CALL XorvReputation setEscrow(address): [0xe65ff691cd9473353a186783f09968fe9a66fb7e92d78ba8c725dfff57113b7b](https://explorer.arc.io/tx/0xe65ff691cd9473353a186783f09968fe9a66fb7e92d78ba8c725dfff57113b7b); status 1; gas 0.0010015530 USDC.
- CREATE XorvCcipReceiver : [0x537a93f3ed18368ed5e2aad82bc1229d17c87451be3db846b4c2ec6fde17ba43](https://explorer.arc.io/tx/0x537a93f3ed18368ed5e2aad82bc1229d17c87451be3db846b4c2ec6fde17ba43); status 1; gas 0.0707029260 USDC.
- CALL XorvEscrow setFunder(address,bool): [0xc3d972a1ce5a4fdcfc96bad31382e07ce6b3f1a2a49aa9249d10cb3ab781284b](https://explorer.arc.io/tx/0xc3d972a1ce5a4fdcfc96bad31382e07ce6b3f1a2a49aa9249d10cb3ab781284b); status 1; gas 0.0010058160 USDC.
- service float XORV_BROKER_ADDRESS .6: [0x9b243ef8a8515eb50ff5c7fec08179b343a3710ad6a292b6b3e44003e12b3a92](https://explorer.arc.io/tx/0x9b243ef8a8515eb50ff5c7fec08179b343a3710ad6a292b6b3e44003e12b3a92); status 1; gas 0.0004410000 USDC.
- service float KEEPER_ADDRESS .2: [0x3fa6e48ea387a3ca9f816343c2069e9c3a7ba73d34d7064497c4a54196f5d0d4](https://explorer.arc.io/tx/0x3fa6e48ea387a3ca9f816343c2069e9c3a7ba73d34d7064497c4a54196f5d0d4); status 1; gas 0.0004410000 USDC.
- service float PROVIDER_ADDRESS .2: [0x1199e6ab080564b42756b4fdf110b017fe1eb4565caabc2956ecf93c099ec7f0](https://explorer.arc.io/tx/0x1199e6ab080564b42756b4fdf110b017fe1eb4565caabc2956ecf93c099ec7f0); status 1; gas 0.0004410000 USDC.
- ERC-8004 mainnet provider registration: [0x1eb3e84dd7a55526350ab021360a430b6b01fff341fd6cb3a38e730066b39f46](https://explorer.arc.io/tx/0x1eb3e84dd7a55526350ab021360a430b6b01fff341fd6cb3a38e730066b39f46); status 1; gas 0.0042192360 USDC.
- Bind mainnet provider identity: [0x7f525cf827cd2fec8b00ea009ef904edc78b38b316d10853029cf59115fd2a58](https://explorer.arc.io/tx/0x7f525cf827cd2fec8b00ea009ef904edc78b38b316d10853029cf59115fd2a58); status 1; gas 0.0013601910 USDC.
- Register smoke provider in ledger: [0x9986472bf0d797813e6cb8ebfecd36836e07df21d08d7401cd35336275fcebc4](https://explorer.arc.io/tx/0x9986472bf0d797813e6cb8ebfecd36836e07df21d08d7401cd35336275fcebc4); status 1; gas 0.0008743350 USDC.
- Smoke: fund 0.01 USDC x402 job: [0x9a03ba343ebb24dd3f1192140c6797b56f866e756f23fffb9a70df4d4977df86](https://explorer.arc.io/tx/0x9a03ba343ebb24dd3f1192140c6797b56f866e756f23fffb9a70df4d4977df86); status 1; gas 0.0043680840 USDC.
- Smoke: release escrow and ERC-8004 reputation: [0x35e45b72d704a59e2082c06975265c53bcc0af8ab058e6ce02f3db68b24ab8ab](https://explorer.arc.io/tx/0x35e45b72d704a59e2082c06975265c53bcc0af8ab058e6ce02f3db68b24ab8ab); status 1; gas 0.0064284150 USDC.
- Record delivered smoke job receipt: [0xecc9f55f159b67905f56a01620419e8bf638097d3c348088f6a6ab93d80b5a2d](https://explorer.arc.io/tx/0xecc9f55f159b67905f56a01620419e8bf638097d3c348088f6a6ab93d80b5a2d); status 1; gas 0.0013835850 USDC.
- Sweep 0.01 USDC smoke principal: [0x5ee2dac1362b28ee0a80ee5a5adfd65d724748f4c8d186369b7deef542b24291](https://explorer.arc.io/tx/0x5ee2dac1362b28ee0a80ee5a5adfd65d724748f4c8d186369b7deef542b24291); status 1; gas 0.0004410000 USDC.

Total recorded project gas: 0.2140399380 USDC.

Mainnet smoke is script-driven; hosted mainnet browser transactions and cross-chain delivery are Not run. Public testnet proof remains separately labelled. Production role keys are outside this repository.

Explorer source verification: attempted; API returned a Cloudflare challenge. Read-only browser smoke verification checks receipts independently.
