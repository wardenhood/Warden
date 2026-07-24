// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title StreamEscrow
/// @notice On-chain escrow + receipt ledger for a Warden-style event push service on Robinhood Chain.
/// @dev Subscribers lock ETH to pay for event deliveries. The off-chain matcher (a trusted relayer
///      address, or later a set of relayers behind a multisig/oracle) calls recordDelivery() after
///      every successful webhook/MCP push. Refunds happen on cancel(). This is the same pattern
///      Sluice uses on Casper, ported to an EVM/Arbitrum Orbit chain.
contract StreamEscrow {
    address public owner;
    address public matcher; // address authorized to record deliveries (swap for a multisig later)
    uint256 public feePerDelivery; // in wei, deducted from subscriber balance per successful push
    uint256 public nextSubId = 1;
    uint256 public totalEscrowed; // running total of active subscription balances (for gas-efficient withdrawFees)

    struct Subscription {
        address subscriber;
        bytes32 predicateHash; // keccak256 of the canonical JSON predicate (full predicate kept off-chain)
        bytes32 webhookHash;   // keccak256(webhook_url) — never store the raw URL on-chain
        uint256 balance;       // remaining wei available to pay for deliveries
        bool active;
    }

    mapping(uint256 => Subscription) public subscriptions;

    event Subscribed(uint256 indexed subId, address indexed subscriber, bytes32 predicateHash, bytes32 webhookHash, uint256 amount);
    event ToppedUp(uint256 indexed subId, uint256 amount, uint256 newBalance);
    event Cancelled(uint256 indexed subId, uint256 refunded);
    event DeliveryRecorded(uint256 indexed subId, bytes32 indexed deliveryId, uint256 feeCharged, uint256 remainingBalance);
    event MatcherUpdated(address indexed newMatcher);
    event FeeUpdated(uint256 newFee);

    error NotOwner();
    error NotMatcher();
    error NotSubscriber();
    error InactiveSubscription();
    error InsufficientBalance();
    error ZeroAmount();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyMatcher() {
        if (msg.sender != matcher) revert NotMatcher();
        _;
    }

    constructor(address _matcher, uint256 _feePerDelivery) {
        owner = msg.sender;
        matcher = _matcher;
        feePerDelivery = _feePerDelivery;
    }

    /// @notice Lock ETH and register a new subscription. predicateHash/webhookHash are
    ///         keccak256 hashes computed off-chain — the matcher keeps the plaintext predicate
    ///         and webhook URL in its own store, keyed by subId, and proves consistency by hash.
    function subscribe(bytes32 predicateHash, bytes32 webhookHash) external payable returns (uint256 subId) {
        if (msg.value == 0) revert ZeroAmount();
        subId = nextSubId++;
        subscriptions[subId] = Subscription({
            subscriber: msg.sender,
            predicateHash: predicateHash,
            webhookHash: webhookHash,
            balance: msg.value,
            active: true
        });
        totalEscrowed += msg.value;
        emit Subscribed(subId, msg.sender, predicateHash, webhookHash, msg.value);
    }

    /// @notice Add more ETH to an existing subscription's balance.
    function topUp(uint256 subId) external payable {
        Subscription storage sub = subscriptions[subId];
        if (msg.sender != sub.subscriber) revert NotSubscriber();
        if (!sub.active) revert InactiveSubscription();
        if (msg.value == 0) revert ZeroAmount();
        sub.balance += msg.value;
        totalEscrowed += msg.value;
        emit ToppedUp(subId, msg.value, sub.balance);
    }

    /// @notice Cancel a subscription and refund whatever balance remains.
    function cancel(uint256 subId) external {
        Subscription storage sub = subscriptions[subId];
        if (msg.sender != sub.subscriber) revert NotSubscriber();
        if (!sub.active) revert InactiveSubscription();
        uint256 refund = sub.balance;
        sub.active = false;
        sub.balance = 0;
        (bool ok, ) = payable(msg.sender).call{value: refund}("");
        require(ok, "refund failed");
        totalEscrowed -= refund;
        emit Cancelled(subId, refund);
    }

    /// @notice Called by the matcher after a successful webhook/MCP delivery. Deducts
    ///         feePerDelivery from the subscription balance and writes an auditable receipt.
    function recordDelivery(uint256 subId, bytes32 deliveryId) external onlyMatcher {
        Subscription storage sub = subscriptions[subId];
        if (!sub.active) revert InactiveSubscription();
        if (sub.balance < feePerDelivery) revert InsufficientBalance();
        sub.balance -= feePerDelivery;
        totalEscrowed -= feePerDelivery;
        emit DeliveryRecorded(subId, deliveryId, feePerDelivery, sub.balance);
        if (sub.balance == 0) {
            sub.active = false;
        }
    }

    /// @notice Batch record deliveries — up to 50 in a single tx for gas efficiency.
    ///         Skips inactive or underfunded subscriptions silently.
    function recordDeliveries(uint256[] calldata subIds, bytes32[] calldata deliveryIds)
        external
        onlyMatcher
    {
        require(subIds.length == deliveryIds.length, "Array length mismatch");
        require(subIds.length <= 50, "Batch too large (max 50)");

        for (uint256 i = 0; i < subIds.length; i++) {
            uint256 subId = subIds[i];
            Subscription storage sub = subscriptions[subId];
            if (!sub.active) continue;
            if (sub.balance < feePerDelivery) continue;

            sub.balance -= feePerDelivery;
            totalEscrowed -= feePerDelivery;
            emit DeliveryRecorded(subId, deliveryIds[i], feePerDelivery, sub.balance);

            if (sub.balance == 0) sub.active = false;
        }
    }

    /// @notice Owner withdraws accumulated fees. Protected against over-withdraw
    ///         from active subscriber escrow balances.
    function withdrawFees(uint256 amount) external onlyOwner {
        uint256 available = address(this).balance - totalEscrowed;
        require(amount <= available, "Exceeds available fees");
        (bool ok, ) = payable(owner).call{value: amount}("");
        require(ok, "withdraw failed");
    }

    function setMatcher(address newMatcher) external onlyOwner {
        matcher = newMatcher;
        emit MatcherUpdated(newMatcher);
    }

    function setFeePerDelivery(uint256 newFee) external onlyOwner {
        feePerDelivery = newFee;
        emit FeeUpdated(newFee);
    }

    function getSubscription(uint256 subId) external view returns (Subscription memory) {
        return subscriptions[subId];
    }
}
