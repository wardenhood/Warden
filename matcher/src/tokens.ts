/**
 * Real Robinhood Chain mainnet Stock Token addresses (chain ID 4663).
 * Source: Quicknode's Robinhood Chain guide, as of July 2026. Robinhood keeps
 * tokenizing more instruments — confirm any address you rely on against
 * Robinscan (https://robinhoodchain.blockscout.com) before using it in production, and note
 * these are OpenZeppelin beacon-proxy contracts, so logic can change behind
 * a stable address.
 *
 * Testnet is chain ID 46630 with a different address set — see
 * https://docs.robinhood.com/chain/connecting
 */
export const RHC_STOCK_TOKENS: Record<string, string> = {
  TSLA: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d",
  AAPL: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9",
  NVDA: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC",
  AMZN: "0x12f190a9F9d7D37a250758b26824B97CE941bF54",
  MSFT: "0xe93237C50D904957Cf27E7B1133b510C669c2e74",
  GOOGL: "0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3",
  META: "0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35",
  MSTR: "0xec262a75e413fAfD0dF80480274532C79D42da09",
  SPY: "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C",
  QCOM: "0x0f17206447090e464C277571124dD2688E48AEA9",
};

// Canonical Multicall3 deployment, present on Robinhood Chain at the standard address.
export const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11";
