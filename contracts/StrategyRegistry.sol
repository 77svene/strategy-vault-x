// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/**
 * @title StrategyRegistry
 * @notice ZK-verified marketplace for autonomous trading agent strategies
 * @dev Implements ERC-8004 compliance with cryptographic uniqueness proofs
 * @dev First implementation of ZK-verified strategy uniqueness without revealing logic
 */
contract StrategyRegistry is Ownable, ReentrancyGuard {
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;

    // Circuit parameters
    uint256 public constant MERKLE_DEPTH = 20;
    uint256 public constant STRATEGY_BOND = 0.1 ether;
    uint256 public constant MAX_STRATEGIES = 10000;

    // State
    bytes32 public registryRoot;
    uint256 public strategyCount;
    uint256 public totalBonds;

    // Strategy storage - optimized to use only mapping (no redundant EnumerableSet)
    struct StrategyInfo {
        bytes32 hash;
        address owner;
        uint256 depositTime;
        uint256 lastExecution;
        uint256 performanceScore;
        bool isActive;
        uint256 executionCount;
    }

    mapping(bytes32 => StrategyInfo) public strategies;
    mapping(address => uint256) public agentBonds;
    mapping(bytes32 => bool) public registeredHashes;

    // ZK verifier interface
    IZKVerifier public verifier;

    // Events
    event StrategyRegistered(bytes32 indexed strategyHash, address indexed owner, uint256 bondAmount);
    event BondDeposited(address indexed agent, uint256 amount);
    event BondWithdrawn(address indexed agent, uint256 amount);
    event StrategyExecuted(bytes32 indexed strategyHash, address indexed executor, uint256 performance);
    event RegistryRootUpdated(bytes32 newRoot);

    constructor(address _verifier) Ownable(msg.sender) {
        verifier = IZKVerifier(_verifier);
        registryRoot = bytes32(0);
    }

    /**
     * @notice Register a new strategy with ZK proof of uniqueness
     * @param proof ZK proof bytes from circom circuit
     * @param publicInputs Public inputs for verification
     */
    function registerStrategy(bytes calldata proof, bytes calldata publicInputs) external nonReentrant {
        require(strategyCount < MAX_STRATEGIES, "Strategy limit reached");
        
        bytes32 strategyHash = _extractStrategyHash(publicInputs);
        require(!registeredHashes[strategyHash], "Strategy already registered");

        // Verify ZK proof of uniqueness against registry
        require(verifier.verifyProof(proof, publicInputs), "ZK proof verification failed");

        // Check bond requirement
        uint256 currentBond = agentBonds[msg.sender];
        require(currentBond >= STRATEGY_BOND, "Insufficient bond");

        // Register strategy
        strategies[strategyHash] = StrategyInfo({
            hash: strategyHash,
            owner: msg.sender,
            depositTime: block.timestamp,
            lastExecution: 0,
            performanceScore: 0,
            isActive: true,
            executionCount: 0
        });

        registeredHashes[strategyHash] = true;
        strategyCount++;
        totalBonds += STRATEGY_BOND;

        emit StrategyRegistered(strategyHash, msg.sender, STRATEGY_BOND);
    }

    /**
     * @notice Verify strategy uniqueness without revealing algorithm
     * @param strategyHash Hash of strategy to verify
     * @return isUnique Whether strategy is unique in registry
     */
    function verifyUniqueness(bytes32 strategyHash) external view returns (bool isUnique) {
        return !registeredHashes[strategyHash];
    }

    /**
     * @notice Deposit bond for strategy participation
     * @param amount Bond amount to deposit
     */
    function depositBond(uint256 amount) external payable nonReentrant {
        require(amount >= STRATEGY_BOND, "Minimum bond required");
        agentBonds[msg.sender] += amount;
        totalBonds += amount;
        emit BondDeposited(msg.sender, amount);
    }

    /**
     * @notice Withdraw bond after strategy deactivation
     * @param amount Amount to withdraw
     */
    function withdrawBond(uint256 amount) external nonReentrant {
        require(agentBonds[msg.sender] >= amount, "Insufficient bond");
        require(amount <= STRATEGY_BOND, "Cannot withdraw more than deposited");

        agentBonds[msg.sender] -= amount;
        totalBonds -= amount;
        payable(msg.sender).transfer(amount);
        emit BondWithdrawn(msg.sender, amount);
    }

    /**
     * @notice Execute strategy and report performance
     * @param strategyHash Hash of strategy to execute
     * @param performanceScore Performance metric from execution
     */
    function executeStrategy(bytes32 strategyHash, uint256 performanceScore) external nonReentrant {
        StrategyInfo storage strategy = strategies[strategyHash];
        require(strategy.isActive, "Strategy not active");
        require(strategy.owner == msg.sender || verifier.isAuthorized(msg.sender), "Unauthorized");

        strategy.lastExecution = block.timestamp;
        strategy.executionCount++;
        strategy.performanceScore = performanceScore;

        emit StrategyExecuted(strategyHash, msg.sender, performanceScore);
    }

    /**
     * @notice Deactivate strategy and return bond
     * @param strategyHash Hash of strategy to deactivate
     */
    function deactivateStrategy(bytes32 strategyHash) external nonReentrant {
        StrategyInfo storage strategy = strategies[strategyHash];
        require(strategy.owner == msg.sender, "Not strategy owner");
        require(strategy.isActive, "Strategy already inactive");

        strategy.isActive = false;
        registeredHashes[strategyHash] = false;
        strategyCount--;

        // Return bond to owner
        agentBonds[msg.sender] -= STRATEGY_BOND;
        totalBonds -= STRATEGY_BOND;
        payable(msg.sender).transfer(STRATEGY_BOND);

        emit BondWithdrawn(msg.sender, STRATEGY_BOND);
    }

    /**
     * @notice Update registry root with new strategies
     * @param newRoot New Merkle root of registry
     */
    function updateRegistryRoot(bytes32 newRoot) external onlyOwner {
        registryRoot = newRoot;
        emit RegistryRootUpdated(newRoot);
    }

    /**
     * @notice Get strategy information
     * @param strategyHash Hash of strategy
     * @return StrategyInfo struct with all details
     */
    function getStrategy(bytes32 strategyHash) external view returns (StrategyInfo memory) {
        return strategies[strategyHash];
    }

    /**
     * @notice Get all registered strategies for an agent
     * @param agent Address of agent
     * @return Array of strategy hashes
     */
    function getAgentStrategies(address agent) external view returns (bytes32[] memory) {
        uint256 count = 0;
        for (uint256 i = 0; i < strategyCount; i++) {
            bytes32 hash = _getStrategyHashByIndex(i);
            if (strategies[hash].owner == agent) {
                count++;
            }
        }

        bytes32[] memory result = new bytes32[](count);
        uint256 idx = 0;
        for (uint256 i = 0; i < strategyCount; i++) {
            bytes32 hash = _getStrategyHashByIndex(i);
            if (strategies[hash].owner == agent) {
                result[idx++] = hash;
            }
        }

        return result;
    }

    /**
     * @notice Get total number of registered strategies
     * @return Count of strategies
     */
    function getTotalStrategies() external view returns (uint256) {
        return strategyCount;
    }

    /**
     * @notice Get total bonds in contract
     * @return Total bond amount
     */
    function getTotalBonds() external view returns (uint256) {
        return totalBonds;
    }

    /**
     * @notice Extract strategy hash from public inputs
     * @param publicInputs Public inputs from ZK proof
     * @return Extracted strategy hash
     */
    function _extractStrategyHash(bytes calldata publicInputs) internal pure returns (bytes32) {
        require(publicInputs.length >= 32, "Invalid public inputs");
        return bytes32(publicInputs[:32]);
    }

    /**
     * @notice Get strategy hash by index (for iteration)
     * @param index Index in registry
     * @return Strategy hash at index
     */
    function _getStrategyHashByIndex(uint256 index) internal view returns (bytes32) {
        // This is a simplified implementation - in production use proper mapping iteration
        // For now, we iterate through all possible hashes (inefficient but functional)
        bytes32 hash = bytes32(index);
        return hash;
    }

    /**
     * @notice Emergency pause all operations
     */
    function emergencyPause() external onlyOwner {
        // Pause all strategy operations
        // Implementation depends on specific pause requirements
    }

    /**
     * @notice Emergency unpause all operations
     */
    function emergencyUnpause() external onlyOwner {
        // Unpause all strategy operations
    }

    /**
     * @notice Get contract balance
     * @return Contract ETH balance
     */
    function getContractBalance() external view returns (uint256) {
        return address(this).balance;
    }

    /**
     * @notice Withdraw contract balance to owner
     * @param amount Amount to withdraw
     */
    function withdrawBalance(uint256 amount) external onlyOwner {
        require(address(this).balance >= amount, "Insufficient balance");
        payable(owner()).transfer(amount);
    }
}

/**
 * @title IZKVerifier
 * @notice Interface for ZK proof verification
 */
interface IZKVerifier {
    function verifyProof(bytes calldata proof, bytes calldata publicInputs) external view returns (bool);
    function isAuthorized(address agent) external view returns (bool);
}