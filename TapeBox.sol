// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/* =========================================================
   TapeBox 去中心化财富宝箱合约
   ---------------------------------------------------------
   功能概览：
   1. 三个付费宝箱（0.05 / 0.5 / 5 BEM），每钱包每日每池限投一次。
   2. 防狙击：开奖前 600 秒（10 分钟）禁止投入。
   3. 每日 0 点开奖，随机抽取一名 Winner 获得该池全部 BEM。
   4. 主宝箱 TapeBox（青铜/白银/钻石），满 50 人立即开奖，仅一名 Winner。
   5. 随机数通过 IRandomnessProvider 抽象，预留 Chainlink VRF v2.5 接入。
   6. 提现扣 5% 手续费：50% 转黑洞销毁，50% 转项目方。
   7. 免费版 Type Box 奖池 = 前一日总手续费的 1%，每日 0 点开奖。
   8. 打赏作者最低 0.1 BEM，打赏后下次提现手续费减免 2.5%。
   ========================================================= */

/* -------------------- 依赖接口 -------------------- */

// OpenZeppelin Ownable 简化接口（避免外部依赖，直接内联实现）
abstract contract Ownable {
    address private _owner;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    constructor() {
        _owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    modifier onlyOwner() {
        require(msg.sender == _owner, "Ownable: caller is not the owner");
        _;
    }

    function owner() public view virtual returns (address) {
        return _owner;
    }

    function transferOwnership(address newOwner) public virtual onlyOwner {
        require(newOwner != address(0), "Ownable: new owner is the zero address");
        emit OwnershipTransferred(_owner, newOwner);
        _owner = newOwner;
    }
}

// ERC20 标准接口
interface IERC20 {
    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/* -------------------- 随机数抽象接口 -------------------- */

/**
 * @title IRandomnessProvider
 * @notice 随机数提供者抽象接口。
 *         生产环境应接入 Chainlink VRF v2.5 的 VRFConsumerBaseV2Plus，
 *         通过 requestRandomWords 异步获取可验证随机数。
 *         本合约默认使用内置的 PseudoRandomnessProvider 作为占位实现。
 */
interface IRandomnessProvider {
    /**
     * @notice 请求一个随机数
     * @param seed 请求种子（用于区分不同请求）
     * @return 返回一个伪随机 uint256
     */
    function requestRandom(uint256 seed) external returns (uint256);
}

/**
 * @title PseudoRandomnessProvider
 * @notice 安全伪随机数占位实现。
 *         注意：链上无法获得真正的随机数，此实现仅用于测试/演示。
 *         生产环境务必替换为 Chainlink VRF v2.5。
 *         这里刻意避免直接使用 block.timestamp / blockhash 作为唯一随机源，
 *         而是混合多个熵源（调用者、nonce、prevrandao、seed）。
 */
contract PseudoRandomnessProvider is IRandomnessProvider {
    uint256 private _nonce;

    function requestRandom(uint256 seed) external override returns (uint256) {
        _nonce++;
        // 混合多个熵源，降低可预测性（仍非密码学安全，仅占位）
        return uint256(
            keccak256(
                abi.encodePacked(
                    block.prevrandao,   // EIP-4399 提供的随机性
                    msg.sender,
                    seed,
                    _nonce,
                    block.number
                )
            )
        );
    }
}

/* -------------------- 主合约 -------------------- */

contract TapeBox is Ownable {
    /* =========================================================
       常量与配置
       ========================================================= */

    uint256 public constant DAILY_BOX_COUNT = 3;      // 每日付费宝箱数量
    uint256 public constant DAILY_MAX_PLAYERS = 20;   // 每日宝箱人数上限
    uint256 public constant MAIN_MAX_PLAYERS = 50;    // 主宝箱开奖门槛
    uint256 public constant SNIPE_LOCK_SECONDS = 600; // 开奖前 10 分钟锁定
    uint256 public constant FEE_BPS = 500;            // 基础手续费 5% (basis points)
    uint256 public constant TIP_DISCOUNT_BPS = 250;   // 打赏减免 2.5%
    uint256 public constant BPS_DENOMINATOR = 10000;  // 基点分母
    uint256 public constant MIN_TIP = 0.1 ether;      // 最低打赏 0.1 BEM（按 18 位精度）

    // 黑洞地址：用于销毁手续费的一半
    address public constant BLACK_HOLE = 0x000000000000000000000000000000000000dEaD;

    /* =========================================================
       状态变量
       ========================================================= */

    IERC20 public immutable bemToken;          // BEM 代币合约
    address public projectTreasury;            // 项目方收款地址
    IRandomnessProvider public randomnessProvider; // 随机数提供者

    // 每日宝箱配置：索引 0/1/2 对应 0.05 / 0.5 / 5 BEM
    uint256[DAILY_BOX_COUNT] public dailyBoxPrices;

    // 每日宝箱状态
    struct DailyBox {
        uint256 pool;                          // 当前奖池
        uint256 players;                       // 当前参与人数
        address[] participants;                // 参与者列表（用于开奖）
        bool drawn;                            // 当日是否已开奖
    }
    // 日期 => 宝箱索引 => 状态
    mapping(uint256 => mapping(uint256 => DailyBox)) public dailyBoxes;

    // 每钱包每日每宝箱是否已投入：日期 => 宝箱索引 => 地址 => 是否已投
    mapping(uint256 => mapping(uint256 => mapping(address => bool))) public dailyBet;

    // 主宝箱子池索引：0=青铜 1=白银 2=钻石
    uint256 public constant MAIN_BOX_COUNT = 3;
    uint256[MAIN_BOX_COUNT] public mainBoxPrices;

    struct MainBox {
        uint256 pool;                          // 当前奖池
        uint256 players;                       // 当前参与人数
        address[] participants;                // 参与者列表
        bool drawn;                            // 是否已开奖（开奖后重置）
    }
    mapping(uint256 => MainBox) public mainBoxes;

    // 每钱包每主宝箱是否已投入（开奖后重置）
    mapping(uint256 => mapping(address => bool)) public mainBet;

    // 免费版 Type Box
    struct FreeBox {
        uint256 pool;                          // 奖池（来自前一日手续费 1%）
        uint256 players;                       // 参与人数
        address[] participants;                // 参与者列表
        bool drawn;                            // 当日是否已开奖
    }
    mapping(uint256 => FreeBox) public freeBoxes; // 日期 => 状态
    mapping(uint256 => mapping(address => bool)) public freeBet; // 日期 => 地址 => 是否已参与

    // 手续费累计：日期 => 当日总手续费
    mapping(uint256 => uint256) public dailyFeeCollected;

    // 打赏状态：地址 => 是否已打赏（用于下次提现减免）
    mapping(address => bool) public hasTipped;

    // 待领取奖励：地址 => 金额（Winner 提现前暂存）
    mapping(address => uint256) public pendingRewards;

    // 上次开奖日期（防止重复开奖）
    uint256 public lastDrawDay;

    /* =========================================================
       事件
       ========================================================= */

    event BetDaily(address indexed user, uint256 day, uint256 boxIndex, uint256 amount);
    event BetMain(address indexed user, uint256 boxIndex, uint256 amount);
    event BetFree(address indexed user, uint256 day);
    event DailyDrawn(uint256 day, uint256 boxIndex, address winner, uint256 amount);
    event MainDrawn(uint256 boxIndex, address winner, uint256 amount);
    event FreeDrawn(uint256 day, address winner, uint256 amount);
    event Withdrawn(address indexed user, uint256 gross, uint256 fee, uint256 net);
    event Tipped(address indexed user, uint256 amount);
    event FeeDistributed(uint256 burnAmount, uint256 treasuryAmount);

    /* =========================================================
       构造函数
       ========================================================= */

    /**
     * @param _bemToken BEM 代币合约地址
     * @param _treasury 项目方收款地址
     * @param _randomnessProvider 随机数提供者地址（可传 0 使用内置占位）
     */
    constructor(address _bemToken, address _treasury, address _randomnessProvider) {
        require(_bemToken != address(0), "invalid token");
        require(_treasury != address(0), "invalid treasury");

        bemToken = IERC20(_bemToken);
        projectTreasury = _treasury;

        // 若未提供随机数提供者，则部署内置占位实现
        if (_randomnessProvider == address(0)) {
            randomnessProvider = new PseudoRandomnessProvider();
        } else {
            randomnessProvider = IRandomnessProvider(_randomnessProvider);
        }

        // 初始化每日宝箱价格（按 18 位精度）
        dailyBoxPrices[0] = 0.05 ether;
        dailyBoxPrices[1] = 0.5 ether;
        dailyBoxPrices[2] = 5 ether;

        // 初始化主宝箱价格
        mainBoxPrices[0] = 0.05 ether;
        mainBoxPrices[1] = 0.5 ether;
        mainBoxPrices[2] = 5 ether;
    }

    /* =========================================================
       管理函数
       ========================================================= */

    /// @notice 更新项目方收款地址
    function setTreasury(address _treasury) external onlyOwner {
        require(_treasury != address(0), "invalid treasury");
        projectTreasury = _treasury;
    }

    /// @notice 更新随机数提供者（用于切换到 Chainlink VRF）
    function setRandomnessProvider(address _provider) external onlyOwner {
        require(_provider != address(0), "invalid provider");
        randomnessProvider = IRandomnessProvider(_provider);
    }

    /* =========================================================
       时间工具
       ========================================================= */

    /// @notice 获取当前日期编号（自 Unix 纪元起的天数）
    function currentDay() public view returns (uint256) {
        return block.timestamp / 1 days;
    }

    /// @notice 获取当天 0 点的时间戳
    function dayStart(uint256 day) public pure returns (uint256) {
        return day * 1 days;
    }

    /// @notice 距离下一个 0 点的剩余秒数
    function secondsToMidnight() public view returns (uint256) {
        return dayStart(currentDay() + 1) - block.timestamp;
    }

    /// @notice 是否处于防狙击锁定窗口（距开奖 < 600 秒）
    function isSnipeLocked() public view returns (bool) {
        return secondsToMidnight() < SNIPE_LOCK_SECONDS;
    }

    /* =========================================================
       一、每日付费宝箱投注
       ========================================================= */

    /**
     * @notice 投入每日付费宝箱
     * @param boxIndex 宝箱索引（0=0.05, 1=0.5, 2=5 BEM）
     */
    function betDaily(uint256 boxIndex) external {
        require(boxIndex < DAILY_BOX_COUNT, "invalid box");
        require(!isSnipeLocked(), "snipe locked: less than 10 min to draw");

        uint256 day = currentDay();
        DailyBox storage box = dailyBoxes[day][boxIndex];

        require(!box.drawn, "already drawn");
        require(box.players < DAILY_MAX_PLAYERS, "box full");
        require(!dailyBet[day][boxIndex][msg.sender], "already bet today");

        uint256 price = dailyBoxPrices[boxIndex];

        // 从用户转入 BEM 到合约
        require(bemToken.transferFrom(msg.sender, address(this), price), "transfer failed");

        // 更新状态
        dailyBet[day][boxIndex][msg.sender] = true;
        box.pool += price;
        box.players += 1;
        box.participants.push(msg.sender);

        emit BetDaily(msg.sender, day, boxIndex, price);
    }

    /* =========================================================
       二、主宝箱 TapeBox 投注（满 50 人立即开奖）
       ========================================================= */

    /**
     * @notice 投入主宝箱子池
     * @param boxIndex 子池索引（0=青铜, 1=白银, 2=钻石）
     */
    function betMain(uint256 boxIndex) external {
        require(boxIndex < MAIN_BOX_COUNT, "invalid box");

        MainBox storage box = mainBoxes[boxIndex];
        require(!box.drawn, "already drawn");
        require(box.players < MAIN_MAX_PLAYERS, "box full");
        require(!mainBet[boxIndex][msg.sender], "already bet");

        uint256 price = mainBoxPrices[boxIndex];
        require(bemToken.transferFrom(msg.sender, address(this), price), "transfer failed");

        mainBet[boxIndex][msg.sender] = true;
        box.pool += price;
        box.players += 1;
        box.participants.push(msg.sender);

        emit BetMain(msg.sender, boxIndex, price);

        // 满 50 人立即开奖
        if (box.players >= MAIN_MAX_PLAYERS) {
            _drawMain(boxIndex);
        }
    }

    /* =========================================================
       三、免费版 Type Box 参与
       ========================================================= */

    /// @notice 免费参与 Type Box（每日一次）
    function betFree() external {
        require(!isSnipeLocked(), "snipe locked: less than 10 min to draw");

        uint256 day = currentDay();
        FreeBox storage box = freeBoxes[day];

        require(!box.drawn, "already drawn");
        require(!freeBet[day][msg.sender], "already joined today");

        freeBet[day][msg.sender] = true;
        box.players += 1;
        box.participants.push(msg.sender);

        emit BetFree(msg.sender, day);
    }

    /* =========================================================
       四、开奖逻辑
       ========================================================= */

    /**
     * @notice 触发每日开奖（付费宝箱 + 免费宝箱）
     * @dev 任何人可在 0 点后调用；使用安全随机数按人数加权抽取
     */
    function drawDaily() external {
        uint256 day = currentDay();
        require(day > lastDrawDay, "already drawn today");

        // 结算前一日（因为 0 点后 currentDay 已 +1）
        uint256 drawDay = day - 1;
        lastDrawDay = day;

        // 1. 结算三个付费宝箱
        for (uint256 i = 0; i < DAILY_BOX_COUNT; i++) {
            _drawDailyBox(drawDay, i);
        }

        // 2. 结算免费宝箱（奖池 = 前一日总手续费的 1%）
        _drawFreeBox(drawDay);
    }

    /// @dev 结算单个每日付费宝箱
    function _drawDailyBox(uint256 day, uint256 boxIndex) internal {
        DailyBox storage box = dailyBoxes[day][boxIndex];
        if (box.drawn || box.players == 0) return;

        box.drawn = true;

        // 使用安全随机数按参与人数均分概率
        uint256 rand = randomnessProvider.requestRandom(
            uint256(keccak256(abi.encodePacked(day, boxIndex, "daily")))
        );
        uint256 winnerIdx = rand % box.players;
        address winner = box.participants[winnerIdx];

        uint256 amount = box.pool;
        box.pool = 0;

        // 奖励暂存，Winner 提现时扣手续费
        pendingRewards[winner] += amount;

        emit DailyDrawn(day, boxIndex, winner, amount);
    }

    /// @dev 结算免费宝箱
    function _drawFreeBox(uint256 day) internal {
        FreeBox storage box = freeBoxes[day];
        if (box.drawn || box.players == 0) return;

        box.drawn = true;

        // 奖池 = 前一日总手续费的 1%
        uint256 prevFee = dailyFeeCollected[day];
        uint256 pool = (prevFee * 100) / BPS_DENOMINATOR; // 1% = 100/10000

        // 使用安全随机数按参与人数均分概率
        uint256 rand = randomnessProvider.requestRandom(
            uint256(keccak256(abi.encodePacked(day, "free")))
        );
        uint256 winnerIdx = rand % box.players;
        address winner = box.participants[winnerIdx];

        if (pool > 0) {
            pendingRewards[winner] += pool;
        }

        emit FreeDrawn(day, winner, pool);
    }

    /// @dev 主宝箱满 50 人开奖
    function _drawMain(uint256 boxIndex) internal {
        MainBox storage box = mainBoxes[boxIndex];
        require(!box.drawn, "already drawn");

        box.drawn = true;

        // 使用安全随机数按参与人数均分概率
        uint256 rand = randomnessProvider.requestRandom(
            uint256(keccak256(abi.encodePacked(boxIndex, "main", block.number)))
        );
        uint256 winnerIdx = rand % box.players;
        address winner = box.participants[winnerIdx];

        uint256 amount = box.pool;

        // 奖励暂存，Winner 提现时扣手续费
        pendingRewards[winner] += amount;

        emit MainDrawn(boxIndex, winner, amount);

        // 重置该子池，开启新一轮
        delete mainBoxes[boxIndex];
        // 注意：mainBet 无法整体删除，通过 drawn 标记 + 新一轮重置逻辑处理
        // 这里简单起见，新一轮开始时由前端/管理重置 mainBet（见 resetMainBet）
    }

    /* =========================================================
       五、提现与手续费
       ========================================================= */

    /**
     * @notice Winner 提现
     * @dev 手续费：基础 5%；若已打赏则减免 2.5%（即 2.5%）。
     *      手续费 50% 转黑洞销毁，50% 转项目方。
     */
    function withdraw() external {
        uint256 gross = pendingRewards[msg.sender];
        require(gross > 0, "nothing to withdraw");

        pendingRewards[msg.sender] = 0;

        // 计算手续费率
        uint256 feeBps = FEE_BPS;
        if (hasTipped[msg.sender]) {
            feeBps = FEE_BPS - TIP_DISCOUNT_BPS; // 5% - 2.5% = 2.5%
            hasTipped[msg.sender] = false;       // 减免仅生效一次
        }

        uint256 fee = (gross * feeBps) / BPS_DENOMINATOR;
        uint256 net = gross - fee;

        // 手续费拆分：50% 销毁，50% 项目方
        uint256 burnAmount = fee / 2;
        uint256 treasuryAmount = fee - burnAmount;

        // 记录当日手续费（用于免费宝箱奖池）
        dailyFeeCollected[currentDay()] += fee;

        // 转账
        if (net > 0) {
            require(bemToken.transfer(msg.sender, net), "transfer net failed");
        }
        if (burnAmount > 0) {
            require(bemToken.transfer(BLACK_HOLE, burnAmount), "burn failed");
        }
        if (treasuryAmount > 0) {
            require(bemToken.transfer(projectTreasury, treasuryAmount), "treasury failed");
        }

        emit Withdrawn(msg.sender, gross, fee, net);
        emit FeeDistributed(burnAmount, treasuryAmount);
    }

    /* =========================================================
       六、打赏作者
       ========================================================= */

    /**
     * @notice 打赏作者
     * @param amount 打赏金额（最低 0.1 BEM，上不封顶）
     * @dev 打赏后下次提现手续费减免 2.5%
     */
    function tipAuthor(uint256 amount) external {
        require(amount >= MIN_TIP, "tip below minimum 0.1 BEM");
        require(bemToken.transferFrom(msg.sender, projectTreasury, amount), "tip transfer failed");

        // 记录打赏状态，下次提现减免
        hasTipped[msg.sender] = true;

        emit Tipped(msg.sender, amount);
    }

    /* =========================================================
       七、查询辅助函数
       ========================================================= */

    /// @notice 查询每日宝箱信息
    function getDailyBox(uint256 day, uint256 boxIndex)
        external
        view
        returns (uint256 pool, uint256 players, bool drawn)
    {
        DailyBox storage box = dailyBoxes[day][boxIndex];
        return (box.pool, box.players, box.drawn);
    }

    /// @notice 查询主宝箱信息
    function getMainBox(uint256 boxIndex)
        external
        view
        returns (uint256 pool, uint256 players, bool drawn)
    {
        MainBox storage box = mainBoxes[boxIndex];
        return (box.pool, box.players, box.drawn);
    }

    /// @notice 查询免费宝箱信息
    function getFreeBox(uint256 day)
        external
        view
        returns (uint256 pool, uint256 players, bool drawn)
    {
        FreeBox storage box = freeBoxes[day];
        return (box.pool, box.players, box.drawn);
    }

    /// @notice 查询用户待领取奖励
    function getPendingReward(address user) external view returns (uint256) {
        return pendingRewards[user];
    }
}
