// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {StreamEscrow} from "../src/StreamEscrow.sol";

/// @notice Deploy StreamEscrow to Robinhood Chain (or any EVM chain via --rpc-url).
/// Usage:
///   forge script script/Deploy.s.sol \
///     --rpc-url $RHC_HTTP_URL \
///     --private-key $DEPLOYER_PRIVATE_KEY \
///     --broadcast
contract DeployStreamEscrow is Script {
    function run() external returns (StreamEscrow escrow) {
        address matcherAddress = vm.envAddress("MATCHER_ADDRESS");
        uint256 feePerDelivery = vm.envOr("FEE_PER_DELIVERY_WEI", uint256(100_000_000_000_000)); // default 0.0001 ETH

        vm.startBroadcast();
        escrow = new StreamEscrow(matcherAddress, feePerDelivery);
        vm.stopBroadcast();

        console.log("StreamEscrow deployed at:", address(escrow));
        console.log("matcher:", matcherAddress);
        console.log("feePerDelivery (wei):", feePerDelivery);
    }
}
