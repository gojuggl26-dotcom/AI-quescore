// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;


/**
 * @title IENSResolver
 * @notice ENS Public Resolver インターフェース
 * @dev ENS ノードに紐づく ETH アドレスを取得するために使用する
 *      createSurvey() 内での ENS オーナー確認（addr() = msg.sender 検証）に使用する
 */
interface IENSResolver {
    /**
     * @notice ENS ノードに設定された ETH アドレスを返す
     * @param node ENS namehash (bytes32)
     * @return address payable ノードに紐づくアドレス（未設定の場合は address(0)）
     */
    function addr(bytes32 node) external view returns (address payable);
}