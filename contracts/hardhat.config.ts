import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },
  networks: {
    // Local demo network (default: hardhat in-process node).
    sepolia: {
      url: process.env.AEGIS_RPC_URL || "",
      accounts: process.env.AEGIS_DEPLOYER_KEY ? [process.env.AEGIS_DEPLOYER_KEY] : [],
    },
  },
};

export default config;
