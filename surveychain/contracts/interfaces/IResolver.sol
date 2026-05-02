// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IENSResolver {
    function addr(bytes32 node) external view returns (address);
}
