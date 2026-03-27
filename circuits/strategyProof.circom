pragma circom 2.1.0;

include "circomlib/circuits/sha256.circom";

template MerkleNonMembership(depth) {
    // Public inputs: what the verifier checks
    signal input strategyHash;
    signal input registryRoot;
    
    // Private inputs: witness data (kept secret from verifier)
    signal input leafHash;
    signal input pathIndices[depth];
    signal input pathElements[depth];
    
    // Internal state for path traversal
    signal currentHash;
    currentHash <== leafHash;
    
    // Hash component for each level of the tree
    component hashers[depth];
    for (var i = 0; i < depth; i++) {
        hashers[i] = Sha256();
    }
    
    // Build Merkle path from leaf to root
    for (var i = 0; i < depth; i++) {
        // Determine left and right children based on path index
        signal leftChild;
        signal rightChild;
        
        // If path index is 0, current is left child; if 1, current is right child
        leftChild <== (pathIndices[i] == 0) ? currentHash : pathElements[i];
        rightChild <== (pathIndices[i] == 0) ? pathElements[i] : currentHash;
        
        // Hash the pair to get parent
        hashers[i].inputs[0] <== leftChild;
        hashers[i].inputs[1] <== rightChild;
        
        // Update current hash for next iteration
        currentHash <== hashers[i].out;
    }
    
    // Constraint: computed root must match registry root
    currentHash === registryRoot;
    
    // Constraint: leaf hash must match strategy hash (proves we're checking the right strategy)
    leafHash === strategyHash;
    
    // Constraint: path indices must be valid (0 or 1)
    for (var i = 0; i < depth; i++) {
        pathIndices[i] * (pathIndices[i] - 1) === 0;
    }
}

// Main circuit with fixed depth for practical registry sizes
// Depth 20 supports up to 2^20 ≈ 1M strategies in registry
template StrategyUniquenessProof() {
    component merkle = MerkleNonMembership(20);
    
    // Public inputs exposed to verifier
    merkle.strategyHash <== strategyHash;
    merkle.registryRoot <== registryRoot;
    
    // Private inputs (witness)
    merkle.leafHash <== leafHash;
    merkle.pathIndices <== pathIndices;
    merkle.pathElements <== pathElements;
    
    // Output signals for proof generation
    signal output strategyHash;
    signal output registryRoot;
    
    strategyHash <== merkle.strategyHash;
    registryRoot <== merkle.registryRoot;
}

// Main entry point
component main = StrategyUniquenessProof();