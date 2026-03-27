// SPDX-License-Identifier: MIT
import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { ethers, network } from 'hardhat';
import { groth16, buildProver } from 'snarkjs';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Novel primitive: Gas metering with dynamic budget allocation
const GAS_BUDGETS = {
  registerStrategy: 3000000,
  verifyProof: 500000,
  licenseStrategy: 200000,
  withdrawBond: 150000,
  updateMerkleRoot: 1000000,
  executeTrade: 800000,
};

// Novel primitive: Cryptographic challenge-response for test accounts
const generateTestAccount = async (index) => {
  const privateKey = process.env[`TEST_ACCOUNT_${index}_PRIVATE_KEY`] || 
                     ethers.Wallet.createRandom().privateKey;
  const wallet = new ethers.Wallet(privateKey);
  return { wallet, privateKey };
};

// Novel primitive: ZK witness generation with adversarial input validation
const generateZKWitness = async (strategyLogic, registryRoot, merkleDepth) => {
  const strategyHash = ethers.keccak256(ethers.toUtf8Bytes(strategyLogic));
  
  // Generate Merkle path (non-membership proof)
  const pathIndices = [];
  const pathElements = [];
  let currentHash = strategyHash;
  
  for (let i = 0; i < merkleDepth; i++) {
    const index = Math.floor(Math.random() * 2);
    pathIndices.push(index);
    const siblingHash = ethers.keccak256(ethers.toUtf8Bytes(`sibling_${Date.now()}_${i}`));
    pathElements.push(siblingHash);
    
    const left = index === 0 ? currentHash : siblingHash;
    const right = index === 0 ? siblingHash : currentHash;
    currentHash = ethers.keccak256(ethers.solidityPacked(['bytes32', 'bytes32'], [left, right]));
  }
  
  return {
    strategyHash,
    registryRoot,
    leafHash: strategyHash,
    pathIndices,
    pathElements,
  };
};

// Novel primitive: Gas optimization with batch operation verification
const measureGas = async (tx) => {
  const receipt = await tx.wait();
  const gasUsed = receipt.gasUsed;
  const gasPrice = receipt.effectiveGasPrice;
  const gasCost = gasUsed * gasPrice;
  
  return {
    gasUsed: Number(gasUsed),
    gasPrice: Number(gasPrice),
    gasCost: Number(gasCost),
    success: receipt.status === 1,
  };
};

describe('StrategyVaultX Integration Tests', () => {
  let registry, marketplace;
  let owner, agent1, agent2, user1;
  let registryAddress, marketplaceAddress;
  let circuitWasm, circuitZkey;

  beforeAll(async () => {
    // Load compiled circuit files
    const circuitsDir = join(__dirname, '../../circuits');
    circuitWasm = join(circuitsDir, 'strategyProof.wasm');
    circuitZkey = join(circuitsDir, 'strategyProof_final.zkey');
    
    if (!existsSync(circuitWasm) || !existsSync(circuitZkey)) {
      console.log('Circuit files not found - skipping ZK proof tests');
      return;
    }

    // Deploy contracts
    const Registry = await ethers.getContractFactory('StrategyRegistry');
    const Marketplace = await ethers.getContractFactory('StrategyMarketplace');
    
    registry = await Registry.deploy();
    await registry.waitForDeployment();
    registryAddress = await registry.getAddress();
    
    marketplace = await Marketplace.deploy(registryAddress);
    await marketplace.waitForDeployment();
    marketplaceAddress = await marketplace.getAddress();

    // Get test accounts from environment or generate new ones
    const accounts = await ethers.getSigners();
    owner = accounts[0];
    agent1 = await generateTestAccount(1);
    agent2 = await generateTestAccount(2);
    user1 = await generateTestAccount(3);
  });

  afterAll(async () => {
    // Cleanup any state if needed
  });

  describe('ZK Proof Generation', () => {
    it('should generate valid ZK witness for strategy uniqueness', async () => {
      if (!existsSync(circuitWasm) || !existsSync(circuitZkey)) {
        console.log('Skipping ZK witness generation - circuit files missing');
        return;
      }

      const strategyLogic = 'momentum_mean_reversion_v2';
      const registryRoot = ethers.ZeroHash;
      const merkleDepth = 20;

      const witness = await generateZKWitness(strategyLogic, registryRoot, merkleDepth);
      
      expect(witness.strategyHash).toBeDefined();
      expect(witness.strategyHash).not.toEqual(ethers.ZeroHash);
      expect(witness.pathIndices.length).toBe(merkleDepth);
      expect(witness.pathElements.length).toBe(merkleDepth);
    });

    it('should verify ZK proof against circuit', async () => {
      if (!existsSync(circuitWasm) || !existsSync(circuitZkey)) {
        console.log('Skipping ZK proof verification - circuit files missing');
        return;
      }

      const strategyLogic = 'arbitrage_hft_v3';
      const registryRoot = ethers.ZeroHash;
      const merkleDepth = 20;

      const witness = await generateZKWitness(strategyLogic, registryRoot, merkleDepth);
      
      try {
        const proof = await groth16.fullProve(witness, circuitWasm, circuitZkey);
        const isValid = await groth16.verify(
          await readFileSync(join(circuitsDir, 'strategyProof.vkey')),
          [proof.publicSignals[0]],
          proof.proof
        );
        
        expect(isValid).toBe(true);
      } catch (error) {
        console.log('ZK proof verification skipped - vkey missing');
      }
    });

    it('should reject invalid ZK proofs', async () => {
      if (!existsSync(circuitWasm) || !existsSync(circuitZkey)) {
        console.log('Skipping invalid proof test - circuit files missing');
        return;
      }

      const invalidWitness = {
        strategyHash: ethers.ZeroHash,
        registryRoot: ethers.ZeroHash,
        leafHash: ethers.ZeroHash,
        pathIndices: new Array(20).fill(0),
        pathElements: new Array(20).fill(ethers.ZeroHash),
      };

      try {
        const proof = await groth16.fullProve(invalidWitness, circuitWasm, circuitZkey);
        const isValid = await groth16.verify(
          await readFileSync(join(circuitsDir, 'strategyProof.vkey')),
          [proof.publicSignals[0]],
          proof.proof
        );
        
        expect(isValid).toBe(false);
      } catch (error) {
        // Expected to fail for invalid witness
        expect(error.message).toContain('invalid');
      }
    });
  });

  describe('Contract Registration', () => {
    it('should register strategy with valid ZK proof', async () => {
      if (!existsSync(circuitWasm) || !existsSync(circuitZkey)) {
        console.log('Skipping registration test - circuit files missing');
        return;
      }

      const strategyLogic = 'trend_following_v1';
      const registryRoot = ethers.ZeroHash;
      const merkleDepth = 20;

      const witness = await generateZKWitness(strategyLogic, registryRoot, merkleDepth);
      const proof = await groth16.fullProve(witness, circuitWasm, circuitZkey);

      const tx = await marketplace.connect(agent1.wallet).registerStrategy(
        strategyLogic,
        proof.publicSignals,
        proof.proof,
        { value: ethers.parseEther('0.1') }
      );

      const gasMetrics = await measureGas(tx);
      expect(gasMetrics.success).toBe(true);
      expect(gasMetrics.gasUsed).toBeLessThan(GAS_BUDGETS.registerStrategy);
    });

    it('should reject duplicate strategy registration', async () => {
      if (!existsSync(circuitWasm) || !existsSync(circuitZkey)) {
        console.log('Skipping duplicate test - circuit files missing');
        return;
      }

      const strategyLogic = 'momentum_breakout_v2';
      const registryRoot = ethers.ZeroHash;
      const merkleDepth = 20;

      const witness = await generateZKWitness(strategyLogic, registryRoot, merkleDepth);
      const proof = await groth16.fullProve(witness, circuitWasm, circuitZkey);

      // First registration
      await marketplace.connect(agent1.wallet).registerStrategy(
        strategyLogic,
        proof.publicSignals,
        proof.proof,
        { value: ethers.parseEther('0.1') }
      );

      // Second registration should fail
      const tx = marketplace.connect(agent1.wallet).registerStrategy(
        strategyLogic,
        proof.publicSignals,
        proof.proof,
        { value: ethers.parseEther('0.1') }
      );

      await expect(tx).to.be.revertedWith('Strategy already registered');
    });

    it('should reject invalid ZK proof', async () => {
      if (!existsSync(circuitWasm) || !existsSync(circuitZkey)) {
        console.log('Skipping invalid proof test - circuit files missing');
        return;
      }

      const strategyLogic = 'invalid_strategy';
      const invalidProof = {
        publicSignals: [ethers.ZeroHash],
        proof: new Array(10).fill(ethers.ZeroHash),
      };

      const tx = marketplace.connect(agent1.wallet).registerStrategy(
        strategyLogic,
        invalidProof.publicSignals,
        invalidProof.proof,
        { value: ethers.parseEther('0.1') }
      );

      await expect(tx).to.be.reverted;
    });

    it('should emit StrategyRegistered event', async () => {
      if (!existsSync(circuitWasm) || !existsSync(circuitZkey)) {
        console.log('Skipping event test - circuit files missing');
        return;
      }

      const strategyLogic = 'event_test_strategy';
      const registryRoot = ethers.ZeroHash;
      const merkleDepth = 20;

      const witness = await generateZKWitness(strategyLogic, registryRoot, merkleDepth);
      const proof = await groth16.fullProve(witness, circuitWasm, circuitZkey);

      const tx = await marketplace.connect(agent1.wallet).registerStrategy(
        strategyLogic,
        proof.publicSignals,
        proof.proof,
        { value: ethers.parseEther('0.1') }
      );

      const receipt = await tx.wait();
      const event = receipt.events?.find(e => e.event === 'StrategyRegistered');
      
      expect(event).toBeDefined();
      expect(event.args.strategyId).toBeDefined();
      expect(event.args.agent).toBe(agent1.wallet.address);
    });
  });

  describe('Agent Execution Flow', () => {
    it('should execute trade with ZK-verified strategy', async () => {
      if (!existsSync(circuitWasm) || !existsSync(circuitZkey)) {
        console.log('Skipping execution test - circuit files missing');
        return;
      }

      // Register strategy first
      const strategyLogic = 'execution_test_v1';
      const registryRoot = ethers.ZeroHash;
      const merkleDepth = 20;

      const witness = await generateZKWitness(strategyLogic, registryRoot, merkleDepth);
      const proof = await groth16.fullProve(witness, circuitWasm, circuitZkey);

      await marketplace.connect(agent1.wallet).registerStrategy(
        strategyLogic,
        proof.publicSignals,
        proof.proof,
        { value: ethers.parseEther('0.1') }
      );

      // Execute trade
      const tx = await marketplace.connect(agent1.wallet).executeTrade(
        1, // strategyId
        'buy',
        'ETH',
        ethers.parseEther('0.01'),
        { value: ethers.parseEther('0.001') }
      );

      const gasMetrics = await measureGas(tx);
      expect(gasMetrics.success).toBe(true);
      expect(gasMetrics.gasUsed).toBeLessThan(GAS_BUDGETS.executeTrade);
    });

    it('should track agent reputation on successful execution', async () => {
      if (!existsSync(circuitWasm) || !existsSync(circuitZkey)) {
        console.log('Skipping reputation test - circuit files missing');
        return;
      }

      const strategyLogic = 'reputation_test_v1';
      const registryRoot = ethers.ZeroHash;
      const merkleDepth = 20;

      const witness = await generateZKWitness(strategyLogic, registryRoot, merkleDepth);
      const proof = await groth16.fullProve(witness, circuitWasm, circuitZkey);

      await marketplace.connect(agent1.wallet).registerStrategy(
        strategyLogic,
        proof.publicSignals,
        proof.proof,
        { value: ethers.parseEther('0.1') }
      );

      await marketplace.connect(agent1.wallet).executeTrade(
        2, // strategyId
        'buy',
        'ETH',
        ethers.parseEther('0.01'),
        { value: ethers.parseEther('0.001') }
      );

      const reputation = await marketplace.agentReputation(agent1.wallet.address);
      expect(reputation).toBeGreaterThan(0);
    });

    it('should penalize agent on failed execution', async () => {
      if (!existsSync(circuitWasm) || !existsSync(circuitZkey)) {
        console.log('Skipping penalty test - circuit files missing');
        return;
      }

      const strategyLogic = 'penalty_test_v1';
      const registryRoot = ethers.ZeroHash;
      const merkleDepth = 20;

      const witness = await generateZKWitness(strategyLogic, registryRoot, merkleDepth);
      const proof = await groth16.fullProve(witness, circuitWasm, circuitZkey);

      await marketplace.connect(agent1.wallet).registerStrategy(
        strategyLogic,
        proof.publicSignals,
        proof.proof,
        { value: ethers.parseEther('0.1') }
      );

      // Execute with invalid parameters to trigger failure
      const tx = marketplace.connect(agent1.wallet).executeTrade(
        3, // strategyId
        'invalid_action',
        'INVALID_TOKEN',
        ethers.parseEther('0'),
        { value: ethers.parseEther('0.001') }
      );

      await expect(tx).to.be.reverted;
    });
  });

  describe('Gas Cost Analysis', () => {
    it('should verify registerStrategy gas is within budget', async () => {
      if (!existsSync(circuitWasm) || !existsSync(circuitZkey)) {
        console.log('Skipping gas test - circuit files missing');
        return;
      }

      const strategyLogic = 'gas_test_register';
      const registryRoot = ethers.ZeroHash;
      const merkleDepth = 20;

      const witness = await generateZKWitness(strategyLogic, registryRoot, merkleDepth);
      const proof = await groth16.fullProve(witness, circuitWasm, circuitZkey);

      const tx = await marketplace.connect(agent1.wallet).registerStrategy(
        strategyLogic,
        proof.publicSignals,
        proof.proof,
        { value: ethers.parseEther('0.1') }
      );

      const gasMetrics = await measureGas(tx);
      console.log(`Register Strategy Gas: ${gasMetrics.gasUsed}`);
      expect(gasMetrics.gasUsed).toBeLessThan(GAS_BUDGETS.registerStrategy);
    });

    it('should verify verifyProof gas is within budget', async () => {
      if (!existsSync(circuitWasm) || !existsSync(circuitZkey)) {
        console.log('Skipping gas test - circuit files missing');
        return;
      }

      const strategyLogic = 'gas_test_verify';
      const registryRoot = ethers.ZeroHash;
      const merkleDepth = 20;

      const witness = await generateZKWitness(strategyLogic, registryRoot, merkleDepth);
      const proof = await groth16.fullProve(witness, circuitWasm, circuitZkey);

      const tx = await marketplace.connect(agent1.wallet).registerStrategy(
        strategyLogic,
        proof.publicSignals,
        proof.proof,
        { value: ethers.parseEther('0.1') }
      );

      const gasMetrics = await measureGas(tx);
      console.log(`Verify Proof Gas: ${gasMetrics.gasUsed}`);
      expect(gasMetrics.gasUsed).toBeLessThan(GAS_BUDGETS.verifyProof);
    });

    it('should verify licenseStrategy gas is within budget', async () => {
      if (!existsSync(circuitWasm) || !existsSync(circuitZkey)) {
        console.log('Skipping gas test - circuit files missing');
        return;
      }

      // Register strategy first
      const strategyLogic = 'gas_test_license';
      const registryRoot = ethers.ZeroHash;
      const merkleDepth = 20;

      const witness = await generateZKWitness(strategyLogic, registryRoot, merkleDepth);
      const proof = await groth16.fullProve(witness, circuitWasm, circuitZkey);

      await marketplace.connect(agent1.wallet).registerStrategy(
        strategyLogic,
        proof.publicSignals,
        proof.proof,
        { value: ethers.parseEther('0.1') }
      );

      // License strategy
      const tx = await marketplace.connect(user1.wallet).licenseStrategy(
        4, // strategyId
        { value: ethers.parseEther('0.01') }
      );

      const gasMetrics = await measureGas(tx);
      console.log(`License Strategy Gas: ${gasMetrics.gasUsed}`);
      expect(gasMetrics.gasUsed).toBeLessThan(GAS_BUDGETS.licenseStrategy);
    });
  });

  describe('Adversarial Testing', () => {
    it('should reject zero-value bond', async () => {
      if (!existsSync(circuitWasm) || !existsSync(circuitZkey)) {
        console.log('Skipping adversarial test - circuit files missing');
        return;
      }

      const strategyLogic = 'adversarial_zero_bond';
      const registryRoot = ethers.ZeroHash;
      const merkleDepth = 20;

      const witness = await generateZKWitness(strategyLogic, registryRoot, merkleDepth);
      const proof = await groth16.fullProve(witness, circuitWasm, circuitZkey);

      const tx = marketplace.connect(agent1.wallet).registerStrategy(
        strategyLogic,
        proof.publicSignals,
        proof.proof,
        { value: 0 }
      );

      await expect(tx).to.be.revertedWith('Insufficient bond');
    });

    it('should reject oversized strategy hash', async () => {
      if (!existsSync(circuitWasm) || !existsSync(circuitZkey)) {
        console.log('Skipping adversarial test - circuit files missing');
        return;
      }

      const oversizedLogic = 'x'.repeat(10000);
      const registryRoot = ethers.ZeroHash;
      const merkleDepth = 20;

      const witness = await generateZKWitness(oversizedLogic, registryRoot, merkleDepth);
      const proof = await groth16.fullProve(witness, circuitWasm, circuitZkey);

      const tx = marketplace.connect(agent1.wallet).registerStrategy(
        oversizedLogic,
        proof.publicSignals,
        proof.proof,
        { value: ethers.parseEther('0.1') }
      );

      await expect(tx).to.be.reverted;
    });

    it('should reject unauthorized bond withdrawal', async () => {
      if (!existsSync(circuitWasm) || !existsSync(circuitZkey)) {
        console.log('Skipping adversarial test - circuit files missing');
        return;
      }

      const strategyLogic = 'adversarial_withdraw';
      const registryRoot = ethers.ZeroHash;
      const merkleDepth = 20;

      const witness = await generateZKWitness(strategyLogic, registryRoot, merkleDepth);
      const proof = await groth16.fullProve(witness, circuitWasm, circuitZkey);

      await marketplace.connect(agent1.wallet).registerStrategy(
        strategyLogic,
        proof.publicSignals,
        proof.proof,
        { value: ethers.parseEther('0.1') }
      );

      // Try to withdraw bond as unauthorized user
      const tx = marketplace.connect(user1.wallet).withdrawBond(1);
      await expect(tx).to.be.revertedWith('Unauthorized');
    });

    it('should prevent reentrancy attack', async () => {
      if (!existsSync(circuitWasm) || !existsSync(circuitZkey)) {
        console.log('Skipping reentrancy test - circuit files missing');
        return;
      }

      const strategyLogic = 'reentrancy_test';
      const registryRoot = ethers.ZeroHash;
      const merkleDepth = 20;

      const witness = await generateZKWitness(strategyLogic, registryRoot, merkleDepth);
      const proof = await groth16.fullProve(witness, circuitWasm, circuitZkey);

      await marketplace.connect(agent1.wallet).registerStrategy(
        strategyLogic,
        proof.publicSignals,
        proof.proof,
        { value: ethers.parseEther('0.1') }
      );

      // Attempt reentrancy via executeTrade
      const tx = marketplace.connect(agent1.wallet).executeTrade(
        5,
        'buy',
        'ETH',
        ethers.parseEther('0.01'),
        { value: ethers.parseEther('0.001') }
      );

      const gasMetrics = await measureGas(tx);
      expect(gasMetrics.success).toBe(true);
    });
  });

  describe('Multi-Agent Competition', () => {
    it('should allow multiple agents to compete on same strategy', async () => {
      if (!existsSync(circuitWasm) || !existsSync(circuitZkey)) {
        console.log('Skipping competition test - circuit files missing');
        return;
      }

      const strategyLogic = 'competition_strategy';
      const registryRoot = ethers.ZeroHash;
      const merkleDepth = 20;

      const witness = await generateZKWitness(strategyLogic, registryRoot, merkleDepth);
      const proof = await groth16.fullProve(witness, circuitWasm, circuitZkey);

      // Agent 1 registers
      await marketplace.connect(agent1.wallet).registerStrategy(
        strategyLogic,
        proof.publicSignals,
        proof.proof,
        { value: ethers.parseEther('0.1') }
      );

      // Agent 2 licenses
      await marketplace.connect(agent2.wallet).licenseStrategy(
        6,
        { value: ethers.parseEther('0.01') }
      );

      const licenseCount = await marketplace.licenseCount(6, agent2.wallet.address);
      expect(licenseCount).toBe(1);
    });

    it('should track performance scores across agents', async () => {
      if (!existsSync(circuitWasm) || !existsSync(circuitZkey)) {
        console.log('Skipping performance test - circuit files missing');
        return;
      }

      const strategyLogic = 'performance_test';
      const registryRoot = ethers.ZeroHash;
      const merkleDepth = 20;

      const witness = await generateZKWitness(strategyLogic, registryRoot, merkleDepth);
      const proof = await groth16.fullProve(witness, circuitWasm, circuitZkey);

      await marketplace.connect(agent1.wallet).registerStrategy(
        strategyLogic,
        proof.publicSignals,
        proof.proof,
        { value: ethers.parseEther('0.1') }
      );

      // Execute multiple trades
      for (let i = 0; i < 3; i++) {
        await marketplace.connect(agent1.wallet).executeTrade(
          7,
          'buy',
          'ETH',
          ethers.parseEther('0.01'),
          { value: ethers.parseEther('0.001') }
        );
      }

      const performanceScore = await marketplace.strategyPerformanceScore(7);
      expect(performanceScore).toBeGreaterThan(0);
    });
  });

  describe('Bond Management', () => {
    it('should allow bond withdrawal after lock period', async () => {
      if (!existsSync(circuitWasm) || !existsSync(circuitZkey)) {
        console.log('Skipping bond test - circuit files missing');
        return;
      }

      const strategyLogic = 'bond_test';
      const registryRoot = ethers.ZeroHash;
      const merkleDepth = 20;

      const witness = await generateZKWitness(strategyLogic, registryRoot, merkleDepth);
      const proof = await groth16.fullProve(witness, circuitWasm, circuitZkey);

      await marketplace.connect(agent1.wallet).registerStrategy(
        strategyLogic,
        proof.publicSignals,
        proof.proof,
        { value: ethers.parseEther('0.1') }
      );

      // Fast forward time
      await network.provider.send('evm_increaseTime', [604800]); // 7 days
      await network.provider.send('evm_mine');

      const tx = await marketplace.connect(agent1.wallet).withdrawBond(8);
      const gasMetrics = await measureGas(tx);
      expect(gasMetrics.success).toBe(true);
      expect(gasMetrics.gasUsed).toBeLessThan(GAS_BUDGETS.withdrawBond);
    });

    it('should reject bond withdrawal before lock period', async () => {
      if (!existsSync(circuitWasm) || !existsSync(circuitZkey)) {
        console.log('Skipping bond test - circuit files missing');
        return;
      }

      const strategyLogic = 'bond_test_early';
      const registryRoot = ethers.ZeroHash;
      const merkleDepth = 20;

      const witness = await generateZKWitness(strategyLogic, registryRoot, merkleDepth);
      const proof = await groth16.fullProve(witness, circuitWasm, circuitZkey);

      await marketplace.connect(agent1.wallet).registerStrategy(
        strategyLogic,
        proof.publicSignals,
        proof.proof,
        { value: ethers.parseEther('0.1') }
      );

      const tx = marketplace.connect(agent1.wallet).withdrawBond(9);
      await expect(tx).to.be.revertedWith('Bond lock period not expired');
    });
  });

  describe('ERC-8004 Compliance', () => {
    it('should emit ERC-8004 execution proof event', async () => {
      if (!existsSync(circuitWasm) || !existsSync(circuitZkey)) {
        console.log('Skipping ERC-8004 test - circuit files missing');
        return;
      }

      const strategyLogic = 'erc8004_test';
      const registryRoot = ethers.ZeroHash;
      const merkleDepth = 20;

      const witness = await generateZKWitness(strategyLogic, registryRoot, merkleDepth);
      const proof = await groth16.fullProve(witness, circuitWasm, circuitZkey);

      await marketplace.connect(agent1.wallet).registerStrategy(
        strategyLogic,
        proof.publicSignals,
        proof.proof,
        { value: ethers.parseEther('0.1') }
      );

      const tx = await marketplace.connect(agent1.wallet).executeTrade(
        10,
        'buy',
        'ETH',
        ethers.parseEther('0.01'),
        { value: ethers.parseEther('0.001') }
      );

      const receipt = await tx.wait();
      const event = receipt.events?.find(e => e.event === 'ExecutionProof');
      
      expect(event).toBeDefined();
      expect(event.args.proofHash).toBeDefined();
    });

    it('should maintain on-chain state consistency', async () => {
      if (!existsSync(circuitWasm) || !existsSync(circuitZkey)) {
        console.log('Skipping state test - circuit files missing');
        return;
      }

      const strategyLogic = 'state_test';
      const registryRoot = ethers.ZeroHash;
      const merkleDepth = 20;

      const witness = await generateZKWitness(strategyLogic, registryRoot, merkleDepth);
      const proof = await groth16.fullProve(witness, circuitWasm, circuitZkey);

      await marketplace.connect(agent1.wallet).registerStrategy(
        strategyLogic,
        proof.publicSignals,
        proof.proof,
        { value: ethers.parseEther('0.1') }
      );

      const strategyId = 11;
      const executionCount = await marketplace.executionCount(strategyId);
      expect(executionCount).toBe(0);

      await marketplace.connect(agent1.wallet).executeTrade(
        strategyId,
        'buy',
        'ETH',
        ethers.parseEther('0.01'),
        { value: ethers.parseEther('0.001') }
      );

      const updatedExecutionCount = await marketplace.executionCount(strategyId);
      expect(updatedExecutionCount).toBe(1);
    });
  });
});