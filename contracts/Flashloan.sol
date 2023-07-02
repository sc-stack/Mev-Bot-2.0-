pragma solidity ^0.5.0;

pragma experimental ABIEncoderV2;

import "@studydefi/money-legos/dydx/contracts/DydxFlashloanBase.sol";
import "@studydefi/money-legos/dydx/contracts/ICallee.sol";
import {KyberNetworkProxy as IKyberNetworkProxy} from "@studydefi/money-legos/kyber/contracts/KyberNetworkProxy.sol";

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./IUniswapV2Router02.sol";
import "./IWeth.sol";

// Flashloan contract for arbitrage between Kyber and Uniswap
contract Flashloan is ICallee, DydxFlashloanBase {
    enum Direction {
        KyberToUniswap,
        UniswapToKyber
    }
    struct ArbInfo {
        Direction direction;
        uint256 repayAmount;
    }

    event NewArbitrage(Direction direction, uint256 profit, uint256 date);

    IKyberNetworkProxy kyber;
    IUniswapV2Router02 uniswap;
    IWeth weth;
    IERC20 dai;
    address beneficiary;
    address constant KYBER_ETH_ADDRESS =
        0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    // Initialize contract addresses
    constructor(
        address kyberAddress,
        address uniswapAddress,
        address wethAddress,
        address daiAddress,
        address beneficiaryAddress
    ) public {
        kyber = IKyberNetworkProxy(kyberAddress);
        uniswap = IUniswapV2Router02(uniswapAddress);
        weth = IWeth(wethAddress);
        dai = IERC20(daiAddress);
        beneficiary = beneficiaryAddress;
    }

    // Execute arbitrage and handle flashloaned funds
    function callFunction(
        address sender,
        Account.Info memory account,
        bytes memory data
    ) public {
        ArbInfo memory arbInfo = abi.decode(data, (ArbInfo));
        uint256 balanceDai = dai.balanceOf(address(this));

        if (arbInfo.direction == Direction.KyberToUniswap) {
            // Arb: Kyber -> Uniswap
            dai.approve(address(kyber), balanceDai);
            (uint256 expectedRate, ) = kyber.getExpectedRate(
                dai,
                IERC20(KYBER_ETH_ADDRESS),
                balanceDai
            );
            kyber.swapTokenToEther(dai, balanceDai, expectedRate);

            address[] memory path = new address[](2);
            path[0] = address(weth);
            path[1] = address(dai);
            uint256[] memory minOuts = uniswap.getAmountsOut(
                address(this).balance,
                path
            );
            uniswap.swapExactETHForTokens.value(address(this).balance)(
                minOuts[1],
                path,
                address(this),
                now
            );
        } else if (arbInfo.direction == Direction.UniswapToKyber) {
            // Arb: Uniswap -> Kyber
            dai.approve(address(uniswap), balanceDai);
            address[] memory path = new address[](2);
            path[0] = address(dai);
            path[1] = address(weth);
            uint256[] memory minOuts = uniswap.getAmountsOut(balanceDai, path);
            uniswap.swapExactTokensForETH(
                balanceDai,
                minOuts[1],
                path,
                address(this),
                now
            );

            (uint256 expectedRate, ) = kyber.getExpectedRate(
                IERC20(KYBER_ETH_ADDRESS),
                dai,
                address(this).balance
            );
            kyber.swapEtherToToken.value(address(this).balance)(
                dai,
                expectedRate
            );
        }

        require(
            dai.balanceOf(address(this)) >= arbInfo.repayAmount,
            "Not enough funds to repay Dydx loan!"
        );

        uint256 profit = dai.balanceOf(address(this)) - arbInfo.repayAmount;
        dai.transfer(beneficiary, profit);
        emit NewArbitrage(arbInfo.direction, profit, now);
    }

    // Initiate a flashloan
    function initiateFlashloan(
        address _solo,
        address _token,
        uint256 _amount,
        Direction _direction
    ) external {
        ISoloMargin solo = ISoloMargin(_solo);
        uint256 marketId = _getMarketIdFromTokenAddress(_solo, _token);
        uint256 repayAmount = _getRepaymentAmountInternal(_amount);
        IERC20(_token).approve(_solo, repayAmount);

        Actions.ActionArgs[] memory operations = new Actions.ActionArgs[](3);
        operations[0] = _getWithdrawAction(marketId, _amount);
        operations[1] = _getCallAction(
            abi.encode(
                ArbInfo({direction: _direction, repayAmount: repayAmount})
            )
        );
        operations[2] = _getDepositAction(marketId, repayAmount);

        Account.Info[] memory accountInfos = new Account.Info[](1);
        accountInfos[0] = _getAccountInfo();
        solo.operate(accountInfos, operations);
    }

    function() external payable {}
}
