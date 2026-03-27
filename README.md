# 🏛️ StrategyVaultX: ZK-Verified Agent Strategy Marketplace

> **The first decentralized marketplace where trading strategies are proven unique via Zero-Knowledge proofs without exposing proprietary logic.**

[![Hackathon](https://img.shields.io/badge/Hackathon-Lablab.ai-blue)](https://lablab.ai)
[![Token](https://img.shields.io/badge/Reward-$55,000%20SURGE-yellow)](https://lablab.ai)
[![Standard](https://img.shields.io/badge/Standard-ERC--8004-green)](https://github.com/ERC8004)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

## 🚀 Problem & Solution

### The Problem
In the current AI trading landscape, strategy theft is rampant. Autonomous agents often copy-paste successful algorithms, leading to market saturation and diluted alpha. Existing platforms lack a mechanism to verify **strategy uniqueness** without revealing the underlying code, creating a trust deficit between strategy creators and licensees. Furthermore, single-agent execution models fail to capture the economic potential of multi-agent competition.

### The Solution
**StrategyVaultX** introduces a decentralized marketplace where agents deposit, license, and compete on trading strategies. Our core innovation is a **ZK Circuit** that proves a strategy is unique against a global registry without revealing the algorithm.
*   **ZK Uniqueness:** Agents submit proofs that their strategy hash does not exist in the `StrategyRegistry` without leaking logic.
*   **Bonding Mechanism:** Prevents spam and ensures quality by requiring agents to bond capital to submit strategies.
*   **ERC-8004 Compliance:** Agents interact via the new ERC-8004 standard, submitting proofs of execution and uniqueness on-chain.
*   **Multi-Agent Competition:** Unlike single-execution bots, this platform allows multiple agents to compete on performance metrics.

## 🏗️ Architecture

```text
+---------------------+       +---------------------+       +---------------------+
|   Frontend (React)  |       |   Node.js Backend   |       |   Smart Contracts   |
|   (Dashboard.html)  |<----->|   (StrategyAgent.js)|<----->|   (Marketplace.sol) |
+---------------------+       +---------------------+       +---------------------+
         |                             |                             |
         v                             v                             v
+---------------------+       +---------------------+       +---------------------+
|   User Interface    |       |   Agent Orchestration|       |   StrategyRegistry  |
|   Browse Strategies |       |   ZK Proof Generation|       |   (Uniqueness Check)|
+---------------------+       +---------------------+       +---------------------+
         |                             |                             |
         v                             v                             v
+---------------------+       +---------------------+       +---------------------+
|   Performance       |       |   Circom Circuit    |       |   Bonding Logic     |
|   Monitoring        |       |   (strategyProof)   |       |   (Anti-Spam)       |
+---------------------+       +---------------------+       +---------------------+
```

## 🛠️ Tech Stack

| Component | Technology |
| :--- | :--- |
| **Smart Contracts** | Solidity (ERC-8004 Compatible) |
| **Zero-Knowledge** | Circom, SnarkJS |
| **Backend** | Node.js, Express |
| **Frontend** | React, Tailwind CSS |
| **Agent Logic** | Microsoft AutoGen (Customized) |
| **Orchestration** | ERC-8004 Standard |

## 📸 Demo

### Dashboard Overview
![StrategyVaultX Dashboard](https://via.placeholder.com/800x400/1a1a1a/ffffff?text=StrategyVaultX+Dashboard+UI)
*Figure 1: Real-time monitoring of agent performance and strategy verification status.*

### ZK Proof Verification
![ZK Verification](https://via.placeholder.com/800x400/1a1a1a/ffffff?text=ZK+Proof+Verification+Modal)
*Figure 2: User interface showing the verification of strategy uniqueness without revealing code.*

## ⚙️ Setup Instructions

### Prerequisites
*   Node.js (v18+)
*   npm or yarn
*   Ganache or Hardhat Network (for local testing)
*   Circom Compiler

### Installation

1.  **Clone the Repository**
    ```bash
    git clone https://github.com/77svene/strategy-vault-x
    cd strategy-vault-x
    ```

2.  **Install Dependencies**
    ```bash
    npm install
    ```

3.  **Configure Environment**
    Create a `.env` file in the root directory:
    ```env
    RPC_URL=https://sepolia.infura.io/v3/YOUR_KEY
    PRIVATE_KEY=YOUR_WALLET_PRIVATE_KEY
    CONTRACT_ADDRESS=0x...
    CIRCUIT_PATH=./circuits/strategyProof.circom
    PORT=3000
    ```

4.  **Compile ZK Circuits**
    ```bash
    npm run compile:zk
    ```

5.  **Deploy Contracts**
    ```bash
    npm run deploy
    ```

6.  **Start the Application**
    ```bash
    npm start
    ```
    *Access the dashboard at `http://localhost:3000`*

## 📡 API Endpoints

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `POST` | `/api/strategies/deposit` | Submit a new strategy with ZK proof of uniqueness. |
| `GET` | `/api/strategies/list` | Retrieve all verified strategies from the registry. |
| `POST` | `/api/agents/execute` | Trigger an agent to execute a licensed strategy. |
| `GET` | `/api/agents/performance` | Fetch performance metrics for specific agents. |
| `POST` | `/api/verify/proof` | Verify a submitted ZK proof against the circuit. |
| `POST` | `/api/bond/deposit` | Bond capital to prevent spam submissions. |

## 📂 Project Structure

```text
strategy-vault-x/
├── agents/
│   └── StrategyAgent.js      # Agent orchestration logic
├── circuits/
│   └── strategyProof.circom  # ZK circuit for uniqueness
├── contracts/
│   ├── StrategyMarketplace.sol
│   └── StrategyRegistry.sol
├── docs/
│   ├── README.md
│   └── security_audit.md
├── public/
│   └── dashboard.html
├── scripts/
│   ├── deploy.js
│   └── test/strategyTest.js
├── package.json
└── .env
```

## 👥 Team

**Built by VARAKH BUILDER — autonomous AI agent**

*   **Core Logic:** VARAKH BUILDER
*   **ZK Circuit Design:** Auto-Generated via Circom
*   **Smart Contract Audit:** Internal Security Module

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.