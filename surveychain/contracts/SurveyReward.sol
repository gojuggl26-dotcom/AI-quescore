// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Ownable2Step, Ownable }          from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { ReentrancyGuard }               from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { ECDSA }                          from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { SafeERC20 }                     from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IERC20 }                        from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC20Permit }                  from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import { IENSRegistry }                  from "./interfaces/IENS.sol";
import { IENSResolver }                  from "./interfaces/IResolver.sol";

contract SurveyReward is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable USDC;
    address public immutable KEEPER_HUB;
    address public immutable ZG_ATTESTATION_SIGNER;
    IENSRegistry public immutable ENS_REGISTRY;

    uint256 public constant FALLBACK_DELAY = 7 days;

    struct Survey {
        address creator;
        uint96  rewardPool;
        uint256 deadline;
        uint32  respondentCount;
        uint8   minQualityScore;
        bool    distributed;
        string  questionCID;
    }

    struct AnswerRecord {
        uint8  qualityScore;
        bool   submitted;
        string cid;
    }

    mapping(bytes32 => Survey)                            public surveys;
    mapping(bytes32 => mapping(address => AnswerRecord))  public answers;
    mapping(bytes32 => address[])                internal  respondentList;
    mapping(address => uint256)                   public   claimableBalance;

    // ── Custom errors ──────────────────────────────────────────────────────────
    error SurveyNotFound(bytes32 ensNode);
    error SurveyAlreadyExists(bytes32 ensNode);
    error NotENSOwner(address caller, address actualOwner);
    error ENSResolverNotSet(bytes32 ensNode);
    error InvalidAttestation(address recovered, address expected);
    error AlreadySubmitted(address respondent);
    error AlreadyDistributed(bytes32 ensNode);
    error DeadlineNotReached(uint256 deadline, uint256 current);
    error SurveyExpired(uint256 deadline, uint256 current);
    error NotKeeperOrFallback();
    error ZeroRewardPool();
    error InvalidDeadline(uint256 deadline);
    error ScoreOutOfRange(uint8 score);
    error RewardAmountTooLarge(uint256 amount);
    error NothingToClaim(address respondent);

    // ── Events ─────────────────────────────────────────────────────────────────
    event SurveyCreated(
        bytes32 indexed ensNode,
        address indexed creator,
        uint256 deadline,
        uint256 rewardPool
    );
    event AnswerSubmitted(
        bytes32 indexed ensNode,
        address indexed respondent,
        uint8   qualityScore,
        string  cid
    );
    event RewardsDistributed(
        bytes32 indexed ensNode,
        uint256 totalDistributed,
        uint256 validRespondents
    );
    event RewardClaimed(
        address indexed respondent,
        uint256 amount
    );
    event KeeperFallbackActivated(
        bytes32 indexed ensNode,
        address indexed caller,
        uint256 timestamp
    );

    // ── Modifier ───────────────────────────────────────────────────────────────
    modifier onlyKeeperOrFallback(bytes32 ensNode) {
        bool isKeeper  = (msg.sender == KEEPER_HUB);
        bool isFallback = (msg.sender == owner()) &&
            (block.timestamp >= surveys[ensNode].deadline + FALLBACK_DELAY);
        if (!isKeeper && !isFallback) revert NotKeeperOrFallback();
        if (isFallback) {
            emit KeeperFallbackActivated(ensNode, msg.sender, block.timestamp);
        }
        _;
    }

    // ── Constructor ────────────────────────────────────────────────────────────
    constructor(
        address _usdc,
        address _keeperHub,
        address _ensRegistry,
        address _zgAttestationSigner
    ) Ownable(msg.sender) {
        require(_usdc                != address(0), "SurveyReward: zero USDC");
        require(_keeperHub           != address(0), "SurveyReward: zero KeeperHub");
        require(_ensRegistry         != address(0), "SurveyReward: zero ENS Registry");
        require(_zgAttestationSigner != address(0), "SurveyReward: zero Signer");

        USDC                  = IERC20(_usdc);
        KEEPER_HUB            = _keeperHub;
        ENS_REGISTRY          = IENSRegistry(_ensRegistry);
        ZG_ATTESTATION_SIGNER = _zgAttestationSigner;
    }

    // ── createSurvey ───────────────────────────────────────────────────────────
    function createSurvey(
        bytes32        ensNode,
        uint256        deadline,
        uint8          minQualityScore,
        uint256        rewardAmount,
        string calldata questionCID,
        uint256        permitDeadline,
        uint8          v,
        bytes32        r,
        bytes32        s
    ) external nonReentrant {
        if (rewardAmount == 0)                      revert ZeroRewardPool();
        if (deadline <= block.timestamp + 1 hours)  revert InvalidDeadline(deadline);
        if (minQualityScore > 100)                  revert ScoreOutOfRange(minQualityScore);
        if (rewardAmount > type(uint96).max)        revert RewardAmountTooLarge(rewardAmount);

        _verifyENSOwner(ensNode, msg.sender);

        if (surveys[ensNode].creator != address(0)) revert SurveyAlreadyExists(ensNode);

        surveys[ensNode] = Survey({
            creator:         msg.sender,
            rewardPool:      uint96(rewardAmount),
            deadline:        deadline,
            respondentCount: 0,
            minQualityScore: minQualityScore,
            distributed:     false,
            questionCID:     questionCID
        });

        IERC20Permit(address(USDC)).permit(
            msg.sender,
            address(this),
            rewardAmount,
            permitDeadline,
            v, r, s
        );
        USDC.safeTransferFrom(msg.sender, address(this), rewardAmount);

        emit SurveyCreated(ensNode, msg.sender, deadline, rewardAmount);
    }

    // ── submitAnswer ───────────────────────────────────────────────────────────
    function submitAnswer(
        bytes32        ensNode,
        string calldata answerCID,
        uint8          qualityScore,
        bytes calldata attestation
    ) external nonReentrant {
        Survey storage s = surveys[ensNode];
        if (s.creator == address(0))          revert SurveyNotFound(ensNode);
        if (block.timestamp >= s.deadline)    revert SurveyExpired(s.deadline, block.timestamp);
        if (qualityScore > 100)               revert ScoreOutOfRange(qualityScore);

        AnswerRecord storage ar = answers[ensNode][msg.sender];
        if (ar.submitted) revert AlreadySubmitted(msg.sender);

        _verifyAttestation(ensNode, msg.sender, qualityScore, answerCID, attestation);

        ar.qualityScore = qualityScore;
        ar.submitted    = true;
        ar.cid          = answerCID;

        respondentList[ensNode].push(msg.sender);
        unchecked { s.respondentCount++; }

        emit AnswerSubmitted(ensNode, msg.sender, qualityScore, answerCID);
    }

    // ── distributeRewards ──────────────────────────────────────────────────────
    function distributeRewards(bytes32 ensNode)
        external
        nonReentrant
        onlyKeeperOrFallback(ensNode)
    {
        Survey storage s = surveys[ensNode];

        if (s.creator == address(0))     revert SurveyNotFound(ensNode);
        if (block.timestamp < s.deadline) revert DeadlineNotReached(s.deadline, block.timestamp);
        if (s.distributed)               revert AlreadyDistributed(ensNode);

        s.distributed = true;

        address[] memory resp    = respondentList[ensNode];
        uint256          respLen  = resp.length;
        uint8            minScore = s.minQualityScore;
        uint256          pool     = uint256(s.rewardPool);

        uint256 totalScore;
        uint256 validCount;

        for (uint256 i; i < respLen;) {
            uint8 sc = answers[ensNode][resp[i]].qualityScore;
            if (sc >= minScore) {
                unchecked {
                    totalScore += sc;
                    validCount++;
                }
            }
            unchecked { i++; }
        }

        if (validCount == 0) {
            claimableBalance[s.creator] += pool;
        } else {
            uint256 accumulated;
            address lastValidAddress;

            for (uint256 i; i < respLen;) {
                address respAddr = resp[i];
                uint8   sc       = answers[ensNode][respAddr].qualityScore;

                if (sc >= minScore) {
                    uint256 share = (pool * uint256(sc)) / totalScore;
                    claimableBalance[respAddr] += share;
                    unchecked {
                        accumulated      += share;
                        lastValidAddress  = respAddr;
                    }
                }
                unchecked { i++; }
            }

            uint256 remainder = pool - accumulated;
            if (remainder > 0) {
                claimableBalance[lastValidAddress] += remainder;
            }
        }

        emit RewardsDistributed(ensNode, pool, validCount);
    }

    // ── withdraw ───────────────────────────────────────────────────────────────
    function withdraw() external nonReentrant {
        uint256 amount = claimableBalance[msg.sender];
        if (amount == 0) revert NothingToClaim(msg.sender);

        claimableBalance[msg.sender] = 0;
        USDC.safeTransfer(msg.sender, amount);

        emit RewardClaimed(msg.sender, amount);
    }

    // ── View helpers ───────────────────────────────────────────────────────────
    function getRespondents(bytes32 ensNode) external view returns (address[] memory) {
        return respondentList[ensNode];
    }

    function surveyExists(bytes32 ensNode) external view returns (bool) {
        return surveys[ensNode].creator != address(0);
    }

    function hasAnswered(bytes32 ensNode, address respondent) external view returns (bool) {
        return answers[ensNode][respondent].submitted;
    }

    // ── Internal ───────────────────────────────────────────────────────────────
    function _verifyENSOwner(bytes32 ensNode, address caller) internal view {
        address resolverAddress = ENS_REGISTRY.resolver(ensNode);
        if (resolverAddress == address(0)) revert ENSResolverNotSet(ensNode);

        address ensOwner = IENSResolver(resolverAddress).addr(ensNode);
        if (ensOwner != caller) revert NotENSOwner(caller, ensOwner);
    }

    function _verifyAttestation(
        bytes32        ensNode,
        address        respondent,
        uint8          qualityScore,
        string calldata cid,
        bytes calldata attestation
    ) internal view {
        bytes32 innerHash = keccak256(
            abi.encodePacked(ensNode, respondent, qualityScore, cid)
        );
        bytes32 msgHash = keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n32", innerHash)
        );
        address recovered = ECDSA.recover(msgHash, attestation);
        if (recovered != ZG_ATTESTATION_SIGNER) {
            revert InvalidAttestation(recovered, ZG_ATTESTATION_SIGNER);
        }
    }
}
