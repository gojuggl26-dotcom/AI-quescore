// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;


/**
 * @title IENSRegistry
 * @notice ENS Registry インターフェース
 * @dev Mainnet / Sepolia 共通アドレス: 0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e
 *      ENS ノード所有者確認とリゾルバアドレス取得に使用する
 */
interface IENSRegistry {
    /**
     * @notice ENS ノードに設定されたリゾルバアドレスを返す
     * @param node ENS namehash (bytes32)
     * @return address リゾルバコントラクトアドレス（未設定の場合は address(0)）
     */
    function resolver(bytes32 node) external view returns (address);


    /**
     * @notice ENS ノードの直接オーナーアドレスを返す
     * @param node ENS namehash (bytes32)
     * @return address オーナーアドレス（未登録の場合は address(0)）
     */
    function owner(bytes32 node) external view returns (address);
}

