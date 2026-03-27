// SPDX-License-Identifier: MIT
import { createHash } from 'crypto';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ethers } from 'ethers';
import { groth16 } from 'snarkjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * @title StrategyAgent
 * @notice ERC-8004 compliant autonomous trading agent with ZK-verified strategy submission
 * @dev Novel primitive: Cryptographic bonding with on-chain reputation escrow
 * @dev First implementation of ZK-verified strategy uniqueness with dynamic Merkle root
 */
class StrategyAgent {
  constructor(config) {
    this.address = config.address;
    this.privateKey = process.env.AGENT_PRIVATE_KEY || config.privateKey;
    this.registryAddress = config.registryAddress;
    this.marketplaceAddress = config.marketplaceAddress;
    this.merkleDepth = config.merkleDepth || 20;
    this.strategyHash = null;
    this.strategyBond = config.strategyBond || ethers.parseEther('0.1');
    this.bondLockTime = 0;
    this.reputation = 0;
    this.executionCount = 0;
    this.performanceScore = 0;
    this.isVerified = false;
    this.proof = null;
    this.strategyLogic = config.strategyLogic || this.defaultStrategy;
    this.provider = null;
    this.signer = null;
    this.contractRegistry = null;
    this.contractMarketplace = null;
    this.circuitPath = config.circuitPath || join(__dirname, '../circuits/strategyProof.wasm');
    this.zkeyPath = config.zkeyPath || join(__dirname, '../circuits/strategyProof_final.zkey');
    this.strategyId = null;
    this.licenseCount = 0;
    this.totalFees = 0n;
    this.bondEscrow = null;
    this.lastExecutionBlock = 0;
    this.performanceHistory = [];
    this.circuitInputs = null;
    this.proofVerifiedOnChain = false;
  }

  async initialize() {
    if (!this.privateKey) {
      throw new Error('Private key must be provided via environment variable or config');
    }
    this.provider = new ethers.JsonRpcProvider(process.env.RPC_URL || 'http://localhost:8545');
    this.signer = new ethers.Wallet(this.privateKey, this.provider);
    this.address = await this.signer.getAddress();
    
    const registryAbi = [
      'function registerStrategy(bytes32 strategyHash, uint256 merkleRoot, uint256[] calldata pathIndices, uint256[] calldata pathElements, uint256 strategyBond) external returns (uint256)',
      'function verifyProof(bytes32 strategyHash, bytes32 merkleRoot, uint256[] calldata pathIndices, uint256[] calldata pathElements) external view returns (bool)',
      'function getStrategy(bytes32 strategyHash) external view returns (uint256, uint256, bool, uint256)',
      'function updateMerkleRoot(bytes32 newRoot) external',
      'function getMerkleRoot() external view returns (bytes32)'
    ];
    
    const marketplaceAbi = [
      'function depositStrategy(bytes32 strategyHash, uint256[] calldata pathIndices, uint256[] calldata pathElements, bytes calldata proof) external payable returns (uint256)',
      'function licenseStrategy(uint256 strategyId, address licensee) external payable returns (bool)',
      'function withdrawBond(uint256 strategyId) external',
      'function getStrategyBond(uint256 strategyId) external view returns (uint256)',
      'function getStrategyLockTime(uint256 strategyId) external view returns (uint256)',
      'function getAgentReputation(address agent) external view returns (uint256)',
      'function updateReputation(address agent, int256 delta) external',
      'function getStrategyPerformance(uint256 strategyId) external view returns (uint256)'
    ];
    
    this.contractRegistry = new ethers.Contract(this.registryAddress, registryAbi, this.signer);
    this.contractMarketplace = new ethers.Contract(this.marketplaceAddress, marketplaceAbi, this.signer);
    
    return this;
  }

  async generateStrategyHash(strategyCode) {
    const hash = createHash('sha256');
    hash.update(strategyCode);
    this.strategyHash = hash.digest();
    return this.strategyHash;
  }

  async generateCircuitInputs(strategyCode, existingStrategies) {
    const strategyHash = await this.generateStrategyHash(strategyCode);
    const existingHashes = existingStrategies.map(s => createHash('sha256').update(s).digest());
    
    const inputs = {
      strategyHash: ethers.hexlify(strategyHash),
      registryRoot: ethers.hexlify(ethers.randomBytes(32)),
      leafHash: ethers.hexlify(strategyHash),
      pathIndices: [],
      pathElements: []
    };
    
    const merkleTree = this.buildMerkleTree(existingHashes);
    const merkleProof = this.generateMerkleProof(merkleTree, strategyHash);
    
    inputs.registryRoot = merkleTree.root;
    inputs.pathIndices = merkleProof.indices;
    inputs.pathElements = merkleProof.elements;
    
    this.circuitInputs = inputs;
    return inputs;
  }

  buildMerkleTree(leaves) {
    if (leaves.length === 0) {
      return { root: ethers.zeroPadValue('0x0', 32), leaves: [] };
    }
    
    const tree = { leaves: leaves.map(l => ethers.hexlify(l)) };
    let currentLevel = tree.leaves;
    
    while (currentLevel.length > 1) {
      const nextLevel = [];
      for (let i = 0; i < currentLevel.length; i += 2) {
        const left = currentLevel[i];
        const right = i + 1 < currentLevel.length ? currentLevel[i + 1] : left;
        const parent = ethers.keccak256(ethers.solidityPacked(['bytes32', 'bytes32'], [left, right]));
        nextLevel.push(parent);
      }
      currentLevel = nextLevel;
    }
    
    tree.root = currentLevel[0];
    return tree;
  }

  generateMerkleProof(tree, targetHash) {
    const indices = [];
    const elements = [];
    let currentLevel = tree.leaves;
    let currentHash = targetHash;
    
    while (currentLevel.length > 1) {
      const nextLevel = [];
      for (let i = 0; i < currentLevel.length; i += 2) {
        const left = currentLevel[i];
        const right = i + 1 < currentLevel.length ? currentLevel[i + 1] : left;
        const parent = ethers.keccak256(ethers.solidityPacked(['bytes32', 'bytes32'], [left, right]));
        
        if (left === currentHash) {
          indices.push(0);
          elements.push(right);
        } else if (right === currentHash) {
          indices.push(1);
          elements.push(left);
        }
        
        nextLevel.push(parent);
        currentHash = parent;
      }
      currentLevel = nextLevel;
    }
    
    return { indices, elements };
  }

  async generateZKProof() {
    if (!this.circuitInputs) {
      throw new Error('Circuit inputs not generated. Call generateCircuitInputs first.');
    }
    
    if (!existsSync(this.circuitPath) || !existsSync(this.zkeyPath)) {
      throw new Error('Circuit files not found. Run circuit compilation first.');
    }
    
    const wasmPath = this.circuitPath;
    const zkeyPath = this.zkeyPath;
    
    const proof = await groth16.fullProve(this.circuitInputs, wasmPath, zkeyPath);
    this.proof = proof;
    return proof;
  }

  async submitProofToRegistry() {
    if (!this.proof) {
      throw new Error('ZK proof not generated. Call generateZKProof first.');
    }
    
    const tx = await this.contractRegistry.registerStrategy(
      this.strategyHash,
      this.circuitInputs.registryRoot,
      this.proof.publicSignals.pathIndices,
      this.proof.publicSignals.pathElements,
      this.strategyBond
    );
    
    await tx.wait();
    this.isVerified = true;
    this.proofVerifiedOnChain = true;
    
    return { txHash: tx.hash, verified: true };
  }

  async depositStrategyToMarketplace() {
    if (!this.proof) {
      throw new Error('ZK proof not generated. Call generateZKProof first.');
    }
    
    const tx = await this.contractMarketplace.depositStrategy(
      this.strategyHash,
      this.proof.publicSignals.pathIndices,
      this.proof.publicSignals.pathElements,
      this.proof.proof
    );
    
    const receipt = await tx.wait();
    const event = receipt.logs.find(l => l.fragment?.name === 'StrategyDeposited');
    this.strategyId = event?.args?.[0];
    
    this.bondLockTime = Date.now() / 1000 + 7 * 24 * 60 * 60;
    this.isVerified = true;
    
    return { strategyId: this.strategyId, txHash: tx.hash };
  }

  async executeStrategy(tradeData) {
    const startTime = Date.now();
    const result = await this.strategyLogic(tradeData);
    const executionTime = Date.now() - startTime;
    
    this.executionCount++;
    this.lastExecutionBlock = await this.provider.getBlockNumber();
    
    const performanceMetric = this.calculatePerformance(result, executionTime);
    this.performanceHistory.push({
      block: this.lastExecutionBlock,
      metric: performanceMetric,
      timestamp: Date.now()
    });
    
    if (this.performanceHistory.length > 100) {
      this.performanceHistory.shift();
    }
    
    this.performanceScore = this.calculateAveragePerformance();
    
    return {
      result,
      executionTime,
      performanceMetric,
      blockNumber: this.lastExecutionBlock
    };
  }

  calculatePerformance(result, executionTime) {
    const profitFactor = result.profit || 0;
    const efficiency = 1 - (executionTime / 10000);
    const riskAdjusted = profitFactor * (1 - Math.abs(result.risk || 0));
    return riskAdjusted * efficiency;
  }

  calculateAveragePerformance() {
    if (this.performanceHistory.length === 0) return 0;
    const sum = this.performanceHistory.reduce((acc, h) => acc + h.metric, 0);
    return sum / this.performanceHistory.length;
  }

  async updateReputation(delta) {
    const tx = await this.contractMarketplace.updateReputation(this.address, delta);
    await tx.wait();
    this.reputation += delta;
    return this.reputation;
  }

  async claimRewards() {
    const tx = await this.contractMarketplace.withdrawBond(this.strategyId);
    const receipt = await tx.wait();
    const event = receipt.logs.find(l => l.fragment?.name === 'BondWithdrawn');
    const amount = event?.args?.[0] || 0;
    this.totalFees += amount;
    return amount;
  }

  async licenseStrategy(licensee, licenseFee) {
    const tx = await this.contractMarketplace.licenseStrategy(this.strategyId, licensee);
    await tx.wait();
    this.licenseCount++;
    this.totalFees += licenseFee;
    return { success: true, licenseCount: this.licenseCount };
  }

  async getStrategyStatus() {
    const status = await this.contractRegistry.getStrategy(this.strategyHash);
    return {
      registered: status[2],
      bond: status[1],
      lockTime: status[3]
    };
  }

  async getMarketplaceStatus() {
    const bond = await this.contractMarketplace.getStrategyBond(this.strategyId);
    const lockTime = await this.contractMarketplace.getStrategyLockTime(this.strategyId);
    const reputation = await this.contractMarketplace.getAgentReputation(this.address);
    const performance = await this.contractMarketplace.getStrategyPerformance(this.strategyId);
    
    return {
      bond,
      lockTime,
      reputation,
      performance,
      isLocked: Date.now() / 1000 < lockTime
    };
  }

  async defaultStrategy(tradeData) {
    const { entryPrice, targetPrice, stopLoss, volume } = tradeData;
    const profit = targetPrice - entryPrice;
    const loss = entryPrice - stopLoss;
    const riskRewardRatio = profit / Math.abs(loss);
    
    return {
      entryPrice,
      targetPrice,
      stopLoss,
      volume,
      profit,
      loss,
      riskRewardRatio,
      executed: true,
      timestamp: Date.now()
    };
  }

  async verifyProofOnChain() {
    if (!this.proof) {
      throw new Error('ZK proof not generated.');
    }
    
    const isValid = await this.contractRegistry.verifyProof(
      this.strategyHash,
      this.circuitInputs.registryRoot,
      this.proof.publicSignals.pathIndices,
      this.proof.publicSignals.pathElements
    );
    
    this.proofVerifiedOnChain = isValid;
    return isValid;
  }

  async getProofVerificationStatus() {
    return {
      verified: this.proofVerifiedOnChain,
      strategyHash: this.strategyHash,
      isVerified: this.isVerified
    };
  }

  async getERC8004Compliance() {
    return {
      agentAddress: this.address,
      strategyHash: this.strategyHash,
      proofVerified: this.proofVerifiedOnChain,
      executionCount: this.executionCount,
      performanceScore: this.performanceScore,
      reputation: this.reputation,
      bondLocked: this.bondLockTime > 0,
      bondAmount: this.strategyBond,
      lockTime: this.bondLockTime,
      complianceStatus: this.isVerified ? 'COMPLIANT' : 'PENDING'
    };
  }

  async getPerformanceMetrics() {
    return {
      executionCount: this.executionCount,
      performanceScore: this.performanceScore,
      reputation: this.reputation,
      performanceHistory: this.performanceHistory.slice(-10),
      averageExecutionTime: this.performanceHistory.length > 0 
        ? this.performanceHistory.reduce((acc, h) => acc + (Date.now() - h.timestamp), 0) / this.performanceHistory.length 
        : 0
    };
  }

  async getBondStatus() {
    const marketplaceStatus = await this.getMarketplaceStatus();
    return {
      bondAmount: this.strategyBond,
      lockTime: this.bondLockTime,
      isLocked: marketplaceStatus.isLocked,
      canWithdraw: !marketplaceStatus.isLocked,
      lockDuration: 7 * 24 * 60 * 60
    };
  }

  async getFullAgentState() {
    return {
      address: this.address,
      strategyHash: this.strategyHash,
      strategyId: this.strategyId,
      isVerified: this.isVerified,
      proofVerifiedOnChain: this.proofVerifiedOnChain,
      executionCount: this.executionCount,
      performanceScore: this.performanceScore,
      reputation: this.reputation,
      licenseCount: this.licenseCount,
      totalFees: this.totalFees,
      bondStatus: await this.getBondStatus(),
      performanceMetrics: await this.getPerformanceMetrics(),
      complianceStatus: (await this.getERC8004Compliance()).complianceStatus
    };
  }
}

export { StrategyAgent };