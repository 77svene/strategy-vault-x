import { ethers } from "hardhat";

async function main() {
  console.log("🚀 Deploying StrategyRegistry to blockchain...");

  // Get deployer account
  const [deployer] = await ethers.getSigners();
  console.log("Deploying with account:", deployer.address);

  // Check balance
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Account balance:", ethers.formatEther(balance), "ETH");

  // Deploy StrategyRegistry contract
  const StrategyRegistry = await ethers.getContractFactory("StrategyRegistry");
  const registry = await StrategyRegistry.deploy();

  await registry.waitForDeployment();
  const registryAddress = await registry.getAddress();
  console.log("✅ StrategyRegistry deployed to:", registryAddress);

  // Verify deployment
  const registryRoot = await registry.registryRoot();
  const strategyCount = await registry.strategyCount();
  const totalBonds = await registry.totalBonds();
  const merkleDepth = await registry.MERKLE_DEPTH();
  const strategyBond = await registry.STRATEGY_BOND();

  console.log("\n📊 Deployment Summary:");
  console.log("  Registry Root:", registryRoot);
  console.log("  Strategy Count:", strategyCount.toString());
  console.log("  Total Bonds:", ethers.formatEther(totalBonds), "ETH");
  console.log("  Merkle Depth:", merkleDepth.toString());
  console.log("  Strategy Bond:", ethers.formatEther(strategyBond), "ETH");

  // Verify contract is not paused
  try {
    const isPaused = await registry.paused();
    console.log("  Contract Paused:", isPaused);
  } catch (e) {
    console.log("  Contract Paused: N/A (not implemented)");
  }

  console.log("\n🎯 Next Steps:");
  console.log("  1. Fund contract with initial bond: 0.1 ETH per strategy");
  console.log("  2. Generate ZK proofs using circom circuit");
  console.log("  3. Register strategies with registerStrategy(proof)");
  console.log("  4. Verify uniqueness with verifyUniqueness(strategyHash)");

  // Save deployment info
  const fs = require("fs");
  const deploymentInfo = {
    network: process.env.HARDHAT_NETWORK || "localhost",
    contract: "StrategyRegistry",
    address: registryAddress,
    deployer: deployer.address,
    timestamp: new Date().toISOString(),
    merkleDepth: merkleDepth.toString(),
    strategyBond: strategyBond.toString(),
  };

  fs.writeFileSync(
    "deployment-info.json",
    JSON.stringify(deploymentInfo, null, 2)
  );
  console.log("\n💾 Deployment info saved to deployment-info.json");

  console.log("\n✅ Deployment complete!");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("❌ Deployment failed:", error);
    process.exit(1);
  });