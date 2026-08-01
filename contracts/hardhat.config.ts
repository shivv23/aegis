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
    hardhat: {},
    // Sepolia. AEGIS_RPC_URL / AEGIS_DEPLOYER_KEY override the defaults so a
    // real deployment works with only a funded deployer key.
    sepolia: {
      url:
        process.env.AEGIS_RPC_URL ||
        "https://ethereum-sepolia-rpc.publicnode.com",
      chainId: 11155111,
      accounts: process.env.AEGIS_DEPLOYER_KEY
        ? [process.env.AEGIS_DEPLOYER_KEY]
        : [],
    },
  },
  etherscan: {
    apiKey: {
      sepolia: process.env.AEGIS_ETHERSCAN_KEY || "",
    },
  },
};

export default config;
