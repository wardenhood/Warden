// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {StreamEscrow} from "../src/StreamEscrow.sol";

contract StreamEscrowTest is Test {
    StreamEscrow escrow;

    address owner = address(this);
    address matcher = address(0xBEEF);
    address subscriber = address(0xCAFE);
    address stranger = address(0xDEAD);

    bytes32 constant PREDICATE_HASH = keccak256("predicate-1");
    bytes32 constant WEBHOOK_HASH = keccak256("https://webhook.site/abc");

    uint256 constant FEE = 0.0001 ether;

    function setUp() public {
        escrow = new StreamEscrow(matcher, FEE);
        vm.deal(subscriber, 10 ether);
        vm.deal(matcher, 1 ether);
    }

    // ---------- subscribe ----------

    function test_subscribe_locksBalanceAndEmits() public {
        vm.prank(subscriber);
        vm.expectEmit(true, true, false, true);
        emit StreamEscrow.Subscribed(1, subscriber, PREDICATE_HASH, WEBHOOK_HASH, 1 ether);
        uint256 subId = escrow.subscribe{value: 1 ether}(PREDICATE_HASH, WEBHOOK_HASH);

        assertEq(subId, 1);
        StreamEscrow.Subscription memory sub = escrow.getSubscription(subId);
        assertEq(sub.subscriber, subscriber);
        assertEq(sub.balance, 1 ether);
        assertTrue(sub.active);
    }

    function test_subscribe_incrementsSubId() public {
        vm.startPrank(subscriber);
        uint256 id1 = escrow.subscribe{value: 0.1 ether}(PREDICATE_HASH, WEBHOOK_HASH);
        uint256 id2 = escrow.subscribe{value: 0.1 ether}(PREDICATE_HASH, WEBHOOK_HASH);
        vm.stopPrank();
        assertEq(id1, 1);
        assertEq(id2, 2);
    }

    function test_subscribe_revertsOnZeroValue() public {
        vm.prank(subscriber);
        vm.expectRevert(StreamEscrow.ZeroAmount.selector);
        escrow.subscribe{value: 0}(PREDICATE_HASH, WEBHOOK_HASH);
    }

    // ---------- topUp ----------

    function test_topUp_increasesBalance() public {
        vm.startPrank(subscriber);
        uint256 subId = escrow.subscribe{value: 1 ether}(PREDICATE_HASH, WEBHOOK_HASH);
        escrow.topUp{value: 0.5 ether}(subId);
        vm.stopPrank();

        assertEq(escrow.getSubscription(subId).balance, 1.5 ether);
    }

    function test_topUp_revertsIfNotSubscriber() public {
        vm.prank(subscriber);
        uint256 subId = escrow.subscribe{value: 1 ether}(PREDICATE_HASH, WEBHOOK_HASH);

        vm.prank(stranger);
        vm.expectRevert(StreamEscrow.NotSubscriber.selector);
        escrow.topUp{value: 0.1 ether}(subId);
    }

    function test_topUp_revertsIfCancelled() public {
        vm.startPrank(subscriber);
        uint256 subId = escrow.subscribe{value: 1 ether}(PREDICATE_HASH, WEBHOOK_HASH);
        escrow.cancel(subId);
        vm.expectRevert(StreamEscrow.InactiveSubscription.selector);
        escrow.topUp{value: 0.1 ether}(subId);
        vm.stopPrank();
    }

    // ---------- cancel ----------

    function test_cancel_refundsFullBalance() public {
        vm.startPrank(subscriber);
        uint256 subId = escrow.subscribe{value: 1 ether}(PREDICATE_HASH, WEBHOOK_HASH);
        uint256 balBefore = subscriber.balance;
        escrow.cancel(subId);
        vm.stopPrank();

        assertEq(subscriber.balance, balBefore + 1 ether);
        StreamEscrow.Subscription memory sub = escrow.getSubscription(subId);
        assertFalse(sub.active);
        assertEq(sub.balance, 0);
    }

    function test_cancel_revertsIfNotSubscriber() public {
        vm.prank(subscriber);
        uint256 subId = escrow.subscribe{value: 1 ether}(PREDICATE_HASH, WEBHOOK_HASH);

        vm.prank(stranger);
        vm.expectRevert(StreamEscrow.NotSubscriber.selector);
        escrow.cancel(subId);
    }

    function test_cancel_revertsIfAlreadyCancelled() public {
        vm.startPrank(subscriber);
        uint256 subId = escrow.subscribe{value: 1 ether}(PREDICATE_HASH, WEBHOOK_HASH);
        escrow.cancel(subId);
        vm.expectRevert(StreamEscrow.InactiveSubscription.selector);
        escrow.cancel(subId);
        vm.stopPrank();
    }

    // ---------- recordDelivery ----------

    function test_recordDelivery_deductsFeeAndEmits() public {
        vm.prank(subscriber);
        uint256 subId = escrow.subscribe{value: 1 ether}(PREDICATE_HASH, WEBHOOK_HASH);

        bytes32 deliveryId = keccak256("delivery-1");
        vm.prank(matcher);
        vm.expectEmit(true, true, false, true);
        emit StreamEscrow.DeliveryRecorded(subId, deliveryId, FEE, 1 ether - FEE);
        escrow.recordDelivery(subId, deliveryId);

        assertEq(escrow.getSubscription(subId).balance, 1 ether - FEE);
    }

    function test_recordDelivery_revertsIfNotMatcher() public {
        vm.prank(subscriber);
        uint256 subId = escrow.subscribe{value: 1 ether}(PREDICATE_HASH, WEBHOOK_HASH);

        vm.prank(stranger);
        vm.expectRevert(StreamEscrow.NotMatcher.selector);
        escrow.recordDelivery(subId, keccak256("x"));
    }

    function test_recordDelivery_autoDeactivatesWhenBalanceHitsZero() public {
        vm.prank(subscriber);
        uint256 subId = escrow.subscribe{value: FEE}(PREDICATE_HASH, WEBHOOK_HASH);

        vm.prank(matcher);
        escrow.recordDelivery(subId, keccak256("d1"));

        StreamEscrow.Subscription memory sub = escrow.getSubscription(subId);
        assertEq(sub.balance, 0);
        assertFalse(sub.active);
    }

    function test_recordDelivery_revertsIfInsufficientBalance() public {
        vm.prank(subscriber);
        uint256 subId = escrow.subscribe{value: FEE / 2}(PREDICATE_HASH, WEBHOOK_HASH);

        vm.prank(matcher);
        vm.expectRevert(StreamEscrow.InsufficientBalance.selector);
        escrow.recordDelivery(subId, keccak256("d1"));
    }

    function test_recordDelivery_revertsIfInactive() public {
        vm.startPrank(subscriber);
        uint256 subId = escrow.subscribe{value: 1 ether}(PREDICATE_HASH, WEBHOOK_HASH);
        escrow.cancel(subId);
        vm.stopPrank();

        vm.prank(matcher);
        vm.expectRevert(StreamEscrow.InactiveSubscription.selector);
        escrow.recordDelivery(subId, keccak256("d1"));
    }

    // ---------- admin ----------

    function test_setMatcher_onlyOwner() public {
        escrow.setMatcher(address(0x1234));
        assertEq(escrow.matcher(), address(0x1234));

        vm.prank(stranger);
        vm.expectRevert(StreamEscrow.NotOwner.selector);
        escrow.setMatcher(address(0x5678));
    }

    function test_setFeePerDelivery_onlyOwner() public {
        escrow.setFeePerDelivery(0.0005 ether);
        assertEq(escrow.feePerDelivery(), 0.0005 ether);

        vm.prank(stranger);
        vm.expectRevert(StreamEscrow.NotOwner.selector);
        escrow.setFeePerDelivery(1 ether);
    }

    function test_withdrawFees_onlyOwner() public {
        vm.prank(subscriber);
        uint256 subId = escrow.subscribe{value: 1 ether}(PREDICATE_HASH, WEBHOOK_HASH);
        vm.prank(matcher);
        escrow.recordDelivery(subId, keccak256("d1"));

        uint256 ownerBalBefore = owner.balance;
        escrow.withdrawFees(FEE);
        assertEq(owner.balance, ownerBalBefore + FEE);

        vm.prank(stranger);
        vm.expectRevert(StreamEscrow.NotOwner.selector);
        escrow.withdrawFees(1);
    }

    // ---------- fuzz ----------

    function testFuzz_subscribeThenCancel_alwaysRefundsExactBalance(uint96 amount) public {
        vm.assume(amount > 0);
        vm.deal(subscriber, uint256(amount) + 1 ether);

        vm.startPrank(subscriber);
        uint256 subId = escrow.subscribe{value: amount}(PREDICATE_HASH, WEBHOOK_HASH);
        uint256 balBefore = subscriber.balance;
        escrow.cancel(subId);
        vm.stopPrank();

        assertEq(subscriber.balance, balBefore + amount);
    }

    function testFuzz_recordDelivery_neverUnderflows(uint96 initialAmount, uint8 numDeliveries) public {
        vm.assume(initialAmount > 0);
        vm.deal(subscriber, uint256(initialAmount) + 1 ether);

        vm.prank(subscriber);
        uint256 subId = escrow.subscribe{value: initialAmount}(PREDICATE_HASH, WEBHOOK_HASH);

        vm.startPrank(matcher);
        for (uint256 i = 0; i < numDeliveries; i++) {
            StreamEscrow.Subscription memory sub = escrow.getSubscription(subId);
            if (!sub.active || sub.balance < FEE) {
                vm.expectRevert();
                escrow.recordDelivery(subId, keccak256(abi.encode(i)));
                break;
            }
            escrow.recordDelivery(subId, keccak256(abi.encode(i)));
        }
        vm.stopPrank();

        // balance must never go negative (impossible in uint anyway, but assert it's sane)
        assertLe(escrow.getSubscription(subId).balance, initialAmount);
    }

    // ═════════════════════════════════════════════════════════════════════════
    // recordDeliveries (batch)
    // ═════════════════════════════════════════════════════════════════════════

    function test_recordDeliveries_deductsFeeAndUpdatesTotalEscrowed() public {
        vm.prank(subscriber);
        uint256 subId = escrow.subscribe{value: 1 ether}(PREDICATE_HASH, WEBHOOK_HASH);

        uint256[] memory ids = new uint256[](1);
        bytes32[] memory dids = new bytes32[](1);
        ids[0] = subId;
        dids[0] = keccak256("batch-1");

        vm.prank(matcher);
        escrow.recordDeliveries(ids, dids);

        assertEq(escrow.getSubscription(subId).balance, 1 ether - FEE);
        assertEq(escrow.totalEscrowed(), 1 ether - FEE);
    }

    function test_recordDeliveries_skipsInactiveAndUnderfunded() public {
        vm.startPrank(subscriber);
        uint256 subActive = escrow.subscribe{value: 1 ether}(PREDICATE_HASH, WEBHOOK_HASH);
        uint256 subCancelled = escrow.subscribe{value: 1 ether}(PREDICATE_HASH, WEBHOOK_HASH);
        escrow.cancel(subCancelled);
        vm.stopPrank();

        uint256[] memory ids = new uint256[](2);
        bytes32[] memory dids = new bytes32[](2);
        ids[0] = subActive; dids[0] = keccak256("a");
        ids[1] = subCancelled; dids[1] = keccak256("b");

        vm.prank(matcher);
        escrow.recordDeliveries(ids, dids);

        assertEq(escrow.getSubscription(subActive).balance, 1 ether - FEE);
        assertEq(escrow.totalEscrowed(), 1 ether - FEE);
    }

    function test_recordDeliveries_revertsOnArrayMismatch() public {
        uint256[] memory ids = new uint256[](2);
        bytes32[] memory dids = new bytes32[](1);
        vm.prank(matcher);
        vm.expectRevert("Array length mismatch");
        escrow.recordDeliveries(ids, dids);
    }

    function test_withdrawFees_revertsIfExceedsAvailable() public {
        vm.prank(subscriber);
        escrow.subscribe{value: 1 ether}(PREDICATE_HASH, WEBHOOK_HASH);
        vm.expectRevert("Exceeds available fees");
        escrow.withdrawFees(1 ether);
    }

    function testFuzz_totalEscrowed_matchesSumOfActiveBalances_mixedBatchAndSingle(uint96 amt1, uint96 amt2, bool useBatch) public {
        vm.assume(amt1 > FEE && amt2 > FEE);
        vm.deal(subscriber, uint256(amt1) + uint256(amt2) + 1 ether);

        vm.startPrank(subscriber);
        uint256 s1 = escrow.subscribe{value: amt1}(PREDICATE_HASH, WEBHOOK_HASH);
        uint256 s2 = escrow.subscribe{value: amt2}(PREDICATE_HASH, WEBHOOK_HASH);
        vm.stopPrank();

        vm.startPrank(matcher);
        if (useBatch) {
            uint256[] memory ids = new uint256[](2);
            bytes32[] memory dids = new bytes32[](2);
            ids[0] = s1; ids[1] = s2;
            dids[0] = keccak256("x"); dids[1] = keccak256("y");
            escrow.recordDeliveries(ids, dids);
        } else {
            escrow.recordDelivery(s1, keccak256("x"));
            escrow.recordDelivery(s2, keccak256("y"));
        }
        vm.stopPrank();

        uint256 expected = escrow.getSubscription(s1).balance + escrow.getSubscription(s2).balance;
        assertEq(escrow.totalEscrowed(), expected);
    }
}
