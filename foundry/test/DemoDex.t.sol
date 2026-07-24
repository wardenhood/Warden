// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {DemoDex} from "../src/DemoDex.sol";

contract DemoDexTest is Test {
    DemoDex dex;

    function setUp() public {
        dex = new DemoDex();
    }

    function test_demoSwapEmitsEvent() public {
        vm.expectEmit(true, true, true, true);
        emit DemoDex.Swap(address(this), address(0xAAA), address(0xBBB), 1000 ether, 950 ether, block.timestamp);
        dex.demoSwap(address(0xAAA), address(0xBBB), 1000 ether, 950 ether);
    }

    function test_demoLiquidationEmitsEvent() public {
        vm.expectEmit(true, true, true, false);
        emit DemoDex.Liquidation(address(this), 500 ether, 600 ether, block.timestamp);
        dex.demoLiquidation(500 ether, 600 ether);
    }

    function test_demoDepositEmitsEvent() public {
        vm.expectEmit(true, true, true, false);
        emit DemoDex.Deposit(address(this), 200 ether, block.timestamp);
        dex.demoDeposit(200 ether);
    }

    function test_demoAllEmitsAllThree() public {
        vm.recordLogs();
        dex.demoAll(address(0xAAA), address(0xBBB), 1000 ether, 500 ether, 200 ether);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 3);
    }

    function test_anyoneCanCall() public {
        vm.prank(address(0xBEEF));
        dex.demoSwap(address(0xAAA), address(0xBBB), 1 ether, 1 ether);
    }
}
