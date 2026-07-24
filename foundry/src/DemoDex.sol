// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title DemoDex
/// @notice Minimal demo contract that emits Swap events for Warden to watch.
///         Deploy on RHC testnet and call demoSwap() on a cron —
///         Warden picks up the event and delivers it to subscribers.
contract DemoDex {
    event Swap(
        address indexed user,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint256 timestamp
    );

    event Liquidation(
        address indexed user,
        uint256 debtAmount,
        uint256 collateralAmount,
        uint256 timestamp
    );

    event Deposit(
        address indexed user,
        uint256 amount,
        uint256 timestamp
    );

    address public owner;

    constructor() {
        owner = msg.sender;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    /// @notice Anyone can fire a demo swap. Zero cost, no real tokens move.
    function demoSwap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut
    ) external {
        emit Swap(msg.sender, tokenIn, tokenOut, amountIn, amountOut, block.timestamp);
    }

    /// @notice Fire a demo liquidation event.
    function demoLiquidation(uint256 debtAmount, uint256 collateralAmount) external {
        emit Liquidation(msg.sender, debtAmount, collateralAmount, block.timestamp);
    }

    /// @notice Fire a demo deposit event.
    function demoDeposit(uint256 amount) external {
        emit Deposit(msg.sender, amount, block.timestamp);
    }

    /// @notice Fire all three event types at once (for demo traffic).
    function demoAll(
        address tokenIn,
        address tokenOut,
        uint256 swapAmount,
        uint256 debtAmount,
        uint256 depositAmount
    ) external {
        emit Swap(msg.sender, tokenIn, tokenOut, swapAmount, swapAmount * 95 / 100, block.timestamp);
        emit Liquidation(msg.sender, debtAmount, debtAmount * 120 / 100, block.timestamp);
        emit Deposit(msg.sender, depositAmount, block.timestamp);
    }

    /// @notice Owner can set a new owner.
    function transferOwnership(address newOwner) external onlyOwner {
        owner = newOwner;
    }
}
