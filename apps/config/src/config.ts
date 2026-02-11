import { base } from "viem/chains";

import type { Config } from "./types";

export const COOLDOWN_ENABLED = true;
export const COOLDOWN_PERIOD = 5 * 60; // 5 minutes
export const ALWAYS_REALIZE_BAD_DEBT = false; // true if you want to always realize bad debt

export const chainConfigs: Record<number, Config> = {
  [base.id]: {
    chain: base,
    morpho: {
      address: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",
      startBlock: 13977148,
    },
    adaptiveCurveIrm: {
      address: "0x46415998764C29aB2a25CbeA6254146D50D22687",
      startBlock: 13977152,
    },
    metaMorphoFactories: {
      addresses: [
        "0xFf62A7c278C62eD665133147129245053Bbf5918",
        "0xA9c3D3a366466Fa809d1Ae982Fb2c46E5fC41101",
      ],
      startBlock: 13978134,
    },
    preLiquidationFactory: {
      address: "0x8cd16b62E170Ee0bA83D80e1F80E6085367e2aef",
      startBlock: 23779056,
    },
    wNative: "0x4200000000000000000000000000000000000006",
    options: {
      vaultWhitelist: "morpho-api",
      additionalMarketsWhitelist: [],
      liquidityVenues: ["erc20Wrapper", "erc4626", "uniswapV3", "uniswapV4", "1inch"],
      pricers: ["chainlink", "defillama", "uniswapV3"],
      liquidationBufferBps: 50,
      useFlashbots: false,
      blockInterval: 4,
    },
  },
};
