// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {DemoDex} from "../src/DemoDex.sol";

/// @notice Deploy DemoDex to RHC testnet/mainnet.
/// Usage:
///   forge script script/DeployDemoDex.s.sol --rpc-url $RHC_RPC --private-key $KEY --broadcast
contract DeployDemoDex is Script {
    function run() external {
        vm.startBroadcast();
        new DemoDex();
        vm.stopBroadcast();
    }
}
