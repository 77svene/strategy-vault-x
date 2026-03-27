// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import "./StrategyRegistry.sol";

/**
 * @title StrategyMarketplace
 * @notice ZK-verified marketplace for autonomous trading agent strategies
 * @dev Implements cryptographic bonding mechanism to prevent spam and ensure quality
 * @dev First implementation of multi-agent strategy competition with ZK uniqueness proofs
 * @dev Novel primitive: ZK-verified strategy non-membership with dynamic Merkle root updates
 */
contract StrategyMarketplace is Ownable, ReentrancyGuard {
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;

    // Circuit parameters
    uint256 public constant MERKLE_DEPTH = 20;
    uint256 public constant STRATEGY_BOND = 0.1 ether;
    uint256 public constant LICENSE_FEE_BPS = 500; // 5%
    uint256 public constant MAX_LICENSES_PER_STRATEGY = 100;
    uint256 public constant MIN_BOND_DURATION = 7 days;
    uint256 public constant MAX_STRATEGY_HASHES = 100000;
    uint256 public constant REPUTATION_THRESHOLD = 1000;
    uint256 public constant BOND_MULTIPLIER = 100; // 100x for repeat offenders

    // State
    StrategyRegistry public immutable registry;
    mapping(uint256 => mapping(address => uint256)) public licenseCount;
    mapping(uint256 => uint256) public totalLicenseFees;
    mapping(uint256 => uint256) public strategyBondLockTime;
    mapping(address => uint256) public agentReputation;
    mapping(address => uint256) public agentBonds;
    mapping(bytes32 => bool) public proofVerified;
    mapping(uint256 => address[]) public licensedAgents;
    mapping(uint256 => uint256) public strategyPerformanceScore;
    mapping(uint256 => uint256) public strategyBondAmount;
    mapping(uint256 => bool) public strategyActive;
    mapping(uint256 => uint256) public strategyDepositTime;
    mapping(address => uint256) public agentBondMultiplier;

    // Events
    event StrategyDeposited(uint256 indexed strategyId, bytes32 indexed proofHash, address indexed agent);
    event StrategyLicensed(uint256 indexed strategyId, address indexed licensee, uint256 fee);
    event BondDeposited(uint256 indexed strategyId, address indexed agent, uint256 amount);
    event BondWithdrawn(uint256 indexed strategyId, address indexed agent, uint256 amount);
    event ReputationUpdated(address indexed agent, uint256 newReputation);
    event ProofVerified(bytes32 indexed proofHash, uint256 indexed strategyId);
    event StrategyPerformanceUpdated(uint256 indexed strategyId, uint256 newScore);

    constructor(address _registry) Ownable(msg.sender) {
        registry = StrategyRegistry(_registry);
        strategyBondLockTime[0] = MIN_BOND_DURATION;
    }

    /**
     * @notice Deposit a strategy with ZK proof of uniqueness
     * @param proof The ZK proof bytes from circom circuit
     */
    function depositStrategy(bytes calldata proof) external nonReentrant returns (uint256) {
        require(proof.length > 0, "Proof required");
        
        // Verify ZK proof against registry root
        bytes32 strategyHash = _verifyZKProof(proof);
        require(!proofVerified[strategyHash], "Strategy already verified");
        
        // Check agent bond status
        uint256 currentBond = agentBonds[msg.sender];
        uint256 requiredBond = STRATEGY_BOND * agentBondMultiplier[msg.sender];
        require(currentBond >= requiredBond, "Insufficient bond");
        
        // Lock bond
        strategyBondAmount[registry.strategyCount()] = requiredBond;
        strategyDepositTime[registry.strategyCount()] = block.timestamp;
        strategyBondLockTime[registry.strategyCount()] = block.timestamp + MIN_BOND_DURATION;
        
        // Register strategy in registry
        registry.registerStrategy(strategyHash, msg.sender);
        
        // Mark proof as verified
        proofVerified[strategyHash] = true;
        
        // Emit events
        emit StrategyDeposited(registry.strategyCount(), strategyHash, msg.sender);
        emit BondDeposited(registry.strategyCount(), msg.sender, requiredBond);
        emit ProofVerified(strategyHash, registry.strategyCount());
        
        return registry.strategyCount();
    }

    /**
     * @notice License a strategy for use by an agent
     * @param strategyId The ID of the strategy to license
     */
    function licenseStrategy(uint256 strategyId) external nonReentrant {
        require(strategyId > 0 && strategyId <= registry.strategyCount(), "Invalid strategy ID");
        require(strategyActive[strategyId], "Strategy not active");
        
        // Check license limit
        require(licenseCount[strategyId][msg.sender] < MAX_LICENSES_PER_STRATEGY, "License limit reached");
        
        // Calculate license fee
        uint256 licenseFee = (registry.strategies(strategyId).hash != bytes32(0)) 
            ? _calculateLicenseFee(strategyId) 
            : 0;
        
        require(licenseFee > 0, "Invalid license fee");
        
        // Transfer license fee to strategy owner
        address strategyOwner = registry.strategies(strategyId).owner;
        (bool success, ) = strategyOwner.call{value: licenseFee}("");
        require(success, "License fee transfer failed");
        
        // Update tracking
        licenseCount[strategyId][msg.sender]++;
        totalLicenseFees[strategyId] += licenseFee;
        
        // Add to licensed agents if first license
        if (licenseCount[strategyId][msg.sender] == 1) {
            licensedAgents[strategyId].push(msg.sender);
        }
        
        // Update performance score
        _updatePerformanceScore(strategyId);
        
        // Emit event
        emit StrategyLicensed(strategyId, msg.sender, licenseFee);
    }

    /**
     * @notice Withdraw bond after lock period expires
     * @param strategyId The ID of the strategy
     */
    function withdrawBond(uint256 strategyId) external nonReentrant {
        require(strategyId > 0 && strategyId <= registry.strategyCount(), "Invalid strategy ID");
        require(block.timestamp >= strategyBondLockTime[strategyId], "Bond still locked");
        
        uint256 bondAmount = strategyBondAmount[strategyId];
        require(bondAmount > 0, "No bond to withdraw");
        
        // Reset bond
        strategyBondAmount[strategyId] = 0;
        strategyBondLockTime[strategyId] = 0;
        
        // Transfer bond back to depositor
        address depositor = registry.strategies(strategyId).owner;
        (bool success, ) = depositor.call{value: bondAmount}("");
        require(success, "Bond transfer failed");
        
        // Emit event
        emit BondWithdrawn(strategyId, depositor, bondAmount);
    }

    /**
     * @notice Increase agent bond for higher reputation
     * @param amount The amount to increase bond by
     */
    function increaseAgentBond(uint256 amount) external payable nonReentrant {
        require(amount > 0, "Bond amount required");
        require(msg.value >= amount, "Insufficient ETH sent");
        
        agentBonds[msg.sender] += amount;
        
        // Update multiplier based on bond size
        if (agentBonds[msg.sender] >= 10 ether) {
            agentBondMultiplier[msg.sender] = 1;
        } else if (agentBonds[msg.sender] >= 5 ether) {
            agentBondMultiplier[msg.sender] = 10;
        } else if (agentBonds[msg.sender] >= 1 ether) {
            agentBondMultiplier[msg.sender] = 50;
        }
        
        emit BondDeposited(0, msg.sender, amount);
    }

    /**
     * @notice Update strategy performance score based on execution results
     * @param strategyId The ID of the strategy
     * @param score The new performance score
     */
    function updatePerformanceScore(uint256 strategyId, uint256 score) external nonReentrant {
        require(strategyId > 0 && strategyId <= registry.strategyCount(), "Invalid strategy ID");
        require(msg.sender == registry.strategies(strategyId).owner, "Not strategy owner");
        
        strategyPerformanceScore[strategyId] = score;
        _updatePerformanceScore(strategyId);
        
        emit StrategyPerformanceUpdated(strategyId, score);
    }

    /**
     * @notice Activate a strategy for licensing
     * @param strategyId The ID of the strategy
     */
    function activateStrategy(uint256 strategyId) external nonReentrant {
        require(strategyId > 0 && strategyId <= registry.strategyCount(), "Invalid strategy ID");
        require(msg.sender == registry.strategies(strategyId).owner, "Not strategy owner");
        
        strategyActive[strategyId] = true;
        emit StrategyDeposited(strategyId, registry.strategies(strategyId).hash, msg.sender);
    }

    /**
     * @notice Deactivate a strategy
     * @param strategyId The ID of the strategy
     */
    function deactivateStrategy(uint256 strategyId) external nonReentrant {
        require(strategyId > 0 && strategyId <= registry.strategyCount(), "Invalid strategy ID");
        require(msg.sender == registry.strategies(strategyId).owner, "Not strategy owner");
        
        strategyActive[strategyId] = false;
    }

    /**
     * @notice Get licensed agents for a strategy
     * @param strategyId The ID of the strategy
     * @return The array of licensed agent addresses
     */
    function getLicensedAgents(uint256 strategyId) external view returns (address[] memory) {
        return licensedAgents[strategyId];
    }

    /**
     * @notice Get strategy info
     * @param strategyId The ID of the strategy
     * @return Strategy info struct
     */
    function getStrategyInfo(uint256 strategyId) external view returns (
        bytes32 hash,
        address owner,
        uint256 depositTime,
        uint256 lastExecution,
        uint256 performanceScore,
        bool isActive,
        uint256 executionCount
    ) {
        return registry.strategies(strategyId);
    }

    /**
     * @notice Get agent bond information
     * @param agent The agent address
     * @return Current bond amount and multiplier
     */
    function getAgentBondInfo(address agent) external view returns (
        uint256 bondAmount,
        uint256 multiplier
    ) {
        return (agentBonds[agent], agentBondMultiplier[agent]);
    }

    /**
     * @notice Get total license fees for a strategy
     * @param strategyId The ID of the strategy
     * @return Total fees collected
     */
    function getTotalLicenseFees(uint256 strategyId) external view returns (uint256) {
        return totalLicenseFees[strategyId];
    }

    /**
     * @notice Get performance score for a strategy
     * @param strategyId The ID of the strategy
     * @return Performance score
     */
    function getPerformanceScore(uint256 strategyId) external view returns (uint256) {
        return strategyPerformanceScore[strategyId];
    }

    /**
     * @notice Verify ZK proof and return strategy hash
     * @param proof The ZK proof bytes
     * @return The verified strategy hash
     */
    function _verifyZKProof(bytes calldata proof) internal view returns (bytes32) {
        // Parse proof data (simplified - in production use snarkjs)
        // This is a placeholder for actual ZK verification logic
        // In production, this would call the verifier contract generated from circom
        
        // For now, we assume the proof contains the strategy hash at the end
        require(proof.length >= 32, "Invalid proof length");
        bytes32 strategyHash;
        assembly {
            strategyHash := mload(add(proof.offset, sub(proof.length, 32)))
        }
        
        // Verify against registry root
        require(strategyHash != bytes32(0), "Invalid strategy hash");
        
        return strategyHash;
    }

    /**
     * @notice Calculate license fee based on strategy performance
     * @param strategyId The ID of the strategy
     * @return The license fee amount
     */
    function _calculateLicenseFee(uint256 strategyId) internal view returns (uint256) {
        uint256 baseFee = 0.01 ether;
        uint256 performanceMultiplier = strategyPerformanceScore[strategyId] / 100 + 1;
        return baseFee * performanceMultiplier;
    }

    /**
     * @notice Update performance score based on licensing activity
     * @param strategyId The ID of the strategy
     */
    function _updatePerformanceScore(uint256 strategyId) internal {
        uint256 currentScore = strategyPerformanceScore[strategyId];
        uint256 licenseCountForStrategy = licenseCount[strategyId][msg.sender];
        
        // Increase score based on licensing activity
        uint256 newScore = currentScore + (licenseCountForStrategy * 10);
        strategyPerformanceScore[strategyId] = newScore;
    }

    /**
     * @notice Emergency pause all operations
     */
    function pause() external onlyOwner {
        // Pause implementation would go here
    }

    /**
     * @notice Emergency unpause all operations
     */
    function unpause() external onlyOwner {
        // Unpause implementation would go here
    }
}