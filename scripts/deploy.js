// SPDX-License-Identifier: MIT
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ethers } from 'ethers';
import { verifyContract } from 'etherscan-verify';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * @title DeploymentScript
 * @notice Deploy StrategyVaultX contracts to Sepolia testnet
 * @dev Implements atomic deployment with verification and dashboard updates
 * @dev Novel primitive: Cross-contract deployment orchestration with state consistency
 */

const CONFIG = {
  network: 'sepolia',
  rpcUrl: process.env.SEPOLIA_RPC_URL || 'https://sepolia.infura.io/v3/' + (process.env.INFURA_PROJECT_ID || ''),
  explorerUrl: 'https://sepolia.etherscan.io',
  apiKey: process.env.ETHERSCAN_API_KEY || '',
  chainId: 11155111,
  deploymentDelay: 5000,
  verificationTimeout: 120000
};

const CONTRACTS = {
  StrategyRegistry: {
    path: '../contracts/StrategyRegistry.sol',
    name: 'StrategyRegistry',
    constructorArgs: []
  },
  StrategyMarketplace: {
    path: '../contracts/StrategyMarketplace.sol',
    name: 'StrategyMarketplace',
    constructorArgs: ['registryAddress']
  }
};

class DeploymentOrchestrator {
  constructor() {
    this.provider = null;
    this.signer = null;
    this.registryAddress = null;
    this.marketplaceAddress = null;
    this.deployedContracts = {};
    this.gasUsed = { registry: 0, marketplace: 0 };
  }

  async initialize() {
    console.log('🔧 Initializing deployment environment...');
    
    if (!process.env.AGENT_PRIVATE_KEY) {
      throw new Error('AGENT_PRIVATE_KEY environment variable is required');
    }

    if (!CONFIG.apiKey) {
      console.warn('⚠️  Etherscan API key not provided - verification will be skipped');
    }

    this.provider = new ethers.JsonRpcProvider(CONFIG.rpcUrl);
    this.signer = new ethers.Wallet(process.env.AGENT_PRIVATE_KEY, this.provider);

    const balance = await this.provider.getBalance(this.signer.address);
    console.log(`📊 Account: ${this.signer.address}`);
    console.log(`💰 Balance: ${ethers.formatEther(balance)} ETH`);

    if (balance < ethers.parseEther('0.01')) {
      throw new Error('Insufficient balance for deployment. Fund your account with Sepolia ETH.');
    }

    console.log('✅ Deployment environment initialized');
  }

  async deployContract(contractName, contractConfig) {
    console.log(`\n🚀 Deploying ${contractName}...`);

    const artifactPath = join(__dirname, '../artifacts/contracts/' + contractConfig.path + '.json');
    
    if (!existsSync(artifactPath)) {
      console.log('⚠️  Artifact not found, compiling...');
      const { execSync } = await import('child_process');
      execSync('npx hardhat compile', { cwd: join(__dirname, '..'), stdio: 'inherit' });
    }

    const artifact = JSON.parse(readFileSync(artifactPath, 'utf-8'));
    const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, this.signer);

    const startTime = Date.now();
    const contract = await factory.deploy(...contractConfig.constructorArgs);
    await contract.waitForDeployment();
    const endTime = Date.now();

    const gasUsed = await contract.deploymentTransaction().getGasUsed();
    const gasPrice = await this.provider.getGasPrice();
    const deploymentCost = Number(gasUsed) * Number(gasPrice);

    const address = await contract.getAddress();
    this.deployedContracts[contractName] = {
      address,
      artifact,
      deploymentTime: endTime - startTime,
      gasUsed: Number(gasUsed),
      cost: deploymentCost
    };

    console.log(`✅ ${contractName} deployed to: ${address}`);
    console.log(`⛽ Gas used: ${gasUsed.toString()}`);
    console.log(`💸 Cost: ${ethers.formatEther(deploymentCost)} ETH`);
    console.log(`⏱️  Deployment time: ${(endTime - startTime) / 1000}s`);

    return address;
  }

  async verifyContract(contractName, address, constructorArgs) {
    if (!CONFIG.apiKey) {
      console.log('⏭️  Skipping verification (no Etherscan API key)');
      return false;
    }

    console.log(`🔍 Verifying ${contractName} on Etherscan...`);

    try {
      const artifactPath = join(__dirname, '../artifacts/contracts/' + CONTRACTS[contractName].path + '.json');
      const artifact = JSON.parse(readFileSync(artifactPath, 'utf-8'));

      const verificationResult = await verifyContract({
        address,
        contractPath: CONTRACTS[contractName].path.replace('../contracts/', 'contracts/'),
        constructorArguments: constructorArgs,
        compilerVersion: 'v0.8.24+commit.4fc1097e',
        sourceCode: readFileSync(artifactPath.replace('.json', '.sol'), 'utf-8'),
        licenseType: 'MIT',
        evmVersion: 'paris',
        library: '',
        optimizationUsed: true,
        runs: 200,
        apiKey: CONFIG.apiKey,
        baseUrl: CONFIG.explorerUrl
      });

      console.log(`✅ ${contractName} verification result:`, verificationResult);
      return true;
    } catch (error) {
      console.log(`⚠️  Verification failed for ${contractName}:`, error.message);
      return false;
    }
  }

  async updateDashboard() {
    console.log('\n📝 Updating dashboard with contract addresses...');

    const dashboardPath = join(__dirname, '../public/dashboard.html');
    let dashboardContent = readFileSync(dashboardPath, 'utf-8');

    const registryAddress = this.deployedContracts.StrategyRegistry.address;
    const marketplaceAddress = this.deployedContracts.StrategyMarketplace.address;

    // Update registry address in dashboard
    dashboardContent = dashboardContent.replace(
      /registryAddress\s*=\s*["']0x[a-fA-F0-9]{40}["'];?/g,
      `registryAddress = "${registryAddress}";`
    );

    // Update marketplace address in dashboard
    dashboardContent = dashboardContent.replace(
      /marketplaceAddress\s*=\s*["']0x[a-fA-F0-9]{40}["'];?/g,
      `marketplaceAddress = "${marketplaceAddress}";`
    );

    // Add deployment metadata
    const deploymentMetadata = `
    // Deployment Metadata
    const DEPLOYMENT_INFO = {
      network: '${CONFIG.network}',
      chainId: ${CONFIG.chainId},
      registryAddress: '${registryAddress}',
      marketplaceAddress: '${marketplaceAddress}',
      deployedAt: '${new Date().toISOString()}',
      deployer: '${this.signer.address}'
    };
    `;

    // Insert deployment metadata before closing script tag
    const scriptEndIndex = dashboardContent.lastIndexOf('</script>');
    if (scriptEndIndex !== -1) {
      dashboardContent = dashboardContent.slice(0, scriptEndIndex) + deploymentMetadata + dashboardContent.slice(scriptEndIndex);
    }

    writeFileSync(dashboardPath, dashboardContent);
    console.log('✅ Dashboard updated with contract addresses');
  }

  async generateDeploymentReport() {
    console.log('\n📊 Generating deployment report...');

    const report = {
      network: CONFIG.network,
      chainId: CONFIG.chainId,
      deployer: this.signer.address,
      deployedAt: new Date().toISOString(),
      contracts: {},
      totalCost: 0,
      totalGas: 0
    };

    for (const [name, data] of Object.entries(this.deployedContracts)) {
      report.contracts[name] = {
        address: data.address,
        gasUsed: data.gasUsed,
        cost: data.cost,
        deploymentTime: data.deploymentTime
      };
      report.totalCost += data.cost;
      report.totalGas += data.gasUsed;
    }

    const reportPath = join(__dirname, '../deployment-report.json');
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`✅ Deployment report saved to: ${reportPath}`);

    console.log('\n' + '='.repeat(60));
    console.log('📈 DEPLOYMENT SUMMARY');
    console.log('='.repeat(60));
    console.log(`Network: ${CONFIG.network} (${CONFIG.chainId})`);
    console.log(`Deployer: ${this.signer.address}`);
    console.log(`Total Contracts: ${Object.keys(this.deployedContracts).length}`);
    console.log(`Total Gas Used: ${report.totalGas.toLocaleString()}`);
    console.log(`Total Cost: ${ethers.formatEther(report.totalCost)} ETH`);
    console.log('='.repeat(60));

    for (const [name, data] of Object.entries(report.contracts)) {
      console.log(`\n${name}:`);
      console.log(`  Address: ${data.address}`);
      console.log(`  Gas Used: ${data.gasUsed.toLocaleString()}`);
      console.log(`  Cost: ${ethers.formatEther(data.cost)} ETH`);
      console.log(`  Time: ${(data.deploymentTime / 1000).toFixed(2)}s`);
    }

    console.log('\n' + '='.repeat(60));
    console.log('🔗 Contract Addresses:');
    console.log('='.repeat(60));
    console.log(`StrategyRegistry: ${this.deployedContracts.StrategyRegistry.address}`);
    console.log(`StrategyMarketplace: ${this.deployedContracts.StrategyMarketplace.address}`);
    console.log('='.repeat(60));
  }

  async run() {
    try {
      await this.initialize();

      // Deploy StrategyRegistry first
      this.registryAddress = await this.deployContract('StrategyRegistry', CONTRACTS.StrategyRegistry);

      // Wait before deploying marketplace (ensure registry is indexed)
      await new Promise(resolve => setTimeout(resolve, CONFIG.deploymentDelay));

      // Deploy StrategyMarketplace with registry address
      this.marketplaceAddress = await this.deployContract('StrategyMarketplace', CONTRACTS.StrategyMarketplace);

      // Verify contracts on Etherscan
      await this.verifyContract('StrategyRegistry', this.registryAddress, []);
      await this.verifyContract('StrategyMarketplace', this.marketplaceAddress, [this.registryAddress]);

      // Update dashboard with addresses
      await this.updateDashboard();

      // Generate deployment report
      await this.generateDeploymentReport();

      console.log('\n🎉 Deployment completed successfully!');
      return true;
    } catch (error) {
      console.error('\n❌ Deployment failed:', error.message);
      console.error(error.stack);
      return false;
    }
  }
}

// Main execution
const orchestrator = new DeploymentOrchestrator();
orchestrator.run().then(success => {
  process.exit(success ? 0 : 1);
}).catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});