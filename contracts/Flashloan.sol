pragma solidity ^0.5.0;

//activate certain feautures of solidity
pragma experimental ABIEncoderV2;

//use other smart contracts defined by this npm package
import "@studydefi/money-legos/dydx/contracts/DydxFlashloanBase.sol";
// interface of kyber provided by money legos package
import "@studydefi/money-legos/dydx/contracts/ICallee.sol";
//The Kyber Contract
import {KyberNetworkProxy as IKyberNetworkProxy} from "@studydefi/money-legos/kyber/contracts/KyberNetworkProxy.sol";

//allows us to interact with an ERC-20 contract - import these interfaces
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./IUniswapV2Router02.sol";
import "./IWeth.sol";

//smart contract inherits from these two other smart contracts allows us to start w built in functionality
// call function and initiate flashloan
contract Flashloan is ICallee, DydxFlashloanBase {
    //enum is an option - direction of the arbitrage
    enum Direction {
        KyberToUniswap,
        UniswapToKyber
    }
    struct ArbInfo {
        Direction direction;
        uint256 repayAmount;
    }

    event NewArbitrage(Direction direction, uint256 profit, uint256 date);

    // declare pointer to these smart contracts
    IKyberNetworkProxy kyber;
    IUniswapV2Router02 uniswap;
    IWeth weth;
    //for dai
    IERC20 dai;
    address beneficiary;
    //a constant that will be used for ether in kyber
    //allows us to save some gas
    address constant KYBER_ETH_ADDRESS =
        0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    // constructor called when sc deployed to the blockchain

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

    //will be called once we withdraw tokens from dydx - we will be doing arbitrage here
    // This is the function that will be called postLoan
    // i.e. Encode the logic to handle your flashloaned funds here
    //we need to decode the arbinfo info struct which will be sent in as the bytes - doesnt use struct name bytes allows for flexiblity
    function callFunction(
        address sender,
        Account.Info memory account,
        bytes memory data
    ) public {
        ArbInfo memory arbInfo = abi.decode(data, (ArbInfo));
        //check that we receive enough tokens from dydx
        //get balance of dai
        //balanceof checks the current accounts balances for that token as specified in the ERC20 standard
        uint256 balanceDai = dai.balanceOf(address(this));

        // Arb 1: buy on kyber sell on uniswap
        if (arbInfo.direction == Direction.KyberToUniswap) {
            //Buy Eth on Kyber
            //sets our allowance approved to spend dai with as balanceDai approve to be spent by kyber
            dai.approve(address(kyber), balanceDai);
            //gets the token conversion rate without any fees -
            // takes input to dai and ether and the balanceDai
            (uint256 expectedRate, ) = kyber.getExpectedRate(
                dai,
                IERC20(KYBER_ETH_ADDRESS),
                balanceDai
            );
            // input token balance and excpcted Rate
            kyber.swapTokenToEther(dai, balanceDai, expectedRate);
            //Sell ETH on uniswap
            //specify a path - aka an array of addresses can go from token a -> b -> c good for code resuability in the future
            address[] memory path = new address[](2);
            path[0] = address(weth);
            path[1] = address(dai);
            //returns an array of integers - given an input asset and an array of token addresses calculates all subsequent maximum output token amounts
            //by calling getReserves fir each pair of token addresses in the path in turn and using these to call getAmountOut
            uint256[] memory minOuts = uniswap.getAmountsOut(
                address(this).balance,
                path
            );
            //call function of uniswap to do trades
            //.value is syntax for sending ether to uniswap
            //deadline parameter is now useful if you are sending a transaction from outside the blockchain
            //swaps an exact amount of ETH for as many output tokens as possible along the route determined by the path
            //now is an alias for block.timestamp
            uniswap.swapExactETHForTokens.value(address(this).balance)(
                minOuts[1],
                path,
                address(this),
                now
            );
        } else if (arbInfo.direction == Direction.UniswapToKyber) {
            //Buy Eth on uniswap
            dai.approve(address(uniswap), balanceDai);
            //specify a path - aka an array of addresses
            address[] memory path = new address[](2);
            path[0] = address(dai);
            path[1] = address(weth);
            //returns an array of integers - given an input asset and an array of token addresses calculates all subsequent maximum output token amounts
            //by calling getReserves fir each pair of token addresses in the path in turn and using these to call getAmountOut
            uint256[] memory minOuts = uniswap.getAmountsOut(balanceDai, path);
            //call function of uniswap to do trades
            //.value is syntax for sending ether to uniswap
            //deadline is now useful if you are sending a transaction from outside the blockchain
            //swaps an exact amount of ETH for as many output tokens as possible along the route determined by the path
            //now is an alias for block.timestamp
            uniswap.swapExactTokensForETH(
                balanceDai,
                minOuts[1],
                path,
                address(this),
                now
            );
            //gets the token conversion rate without any fees -
            //Sell ETH on kyber for DAI
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

        //after arbitrage we should have enough money to repay the loan of dydx - if not the entire transaction will fail
        require(
            dai.balanceOf(address(this)) >= arbInfo.repayAmount,
            "Not enough funds to repay Dydx loan!"
        );

        //calculate the profit - aka the difference between the dai balance of this smart contract and repay amount
        uint256 profit = dai.balanceOf(address(this)) - arbInfo.repayAmount;
        // send profit to the beneficiary address
        dai.transfer(beneficiary, profit);
        //emit an event to describe the arb that just happened
        emit NewArbitrage(arbInfo.direction, profit, now);
    }

    //address of dydx, address of token we want to borrow and then the amount, also the direction
    function initiateFlashloan(
        address _solo,
        address _token,
        uint256 _amount,
        Direction _direction
    ) external {
        //initiate a pointer to the smart contract we want to borrow from
        ISoloMargin solo = ISoloMargin(_solo);

        // Get marketId from token address - different tokens wil yield different market ids
        uint256 marketId = _getMarketIdFromTokenAddress(_solo, _token);

        // Calculate repay amount (_amount + (2 wei))
        // Approve transfer from
        uint256 repayAmount = _getRepaymentAmountInternal(_amount);
        IERC20(_token).approve(_solo, repayAmount);

        // 1. Withdraw $
        // 2. Call callFunction(...)
        // 3. Deposit back $
        Actions.ActionArgs[] memory operations = new Actions.ActionArgs[](3);

        //withdraw action is borrowing the token from dydx
        operations[0] = _getWithdrawAction(marketId, _amount);
        //this is where we do the arbitrage - the call action do arbtragry sc execution
        operations[1] = _getCallAction(
            // Define struct ArbInfo and pass
            abi.encode(
                ArbInfo({direction: _direction, repayAmount: repayAmount})
            )
        );
        //when we pay back the flashloan to dydx - deposit
        operations[2] = _getDepositAction(marketId, repayAmount);

        Account.Info[] memory accountInfos = new Account.Info[](1);
        accountInfos[0] = _getAccountInfo();

        solo.operate(accountInfos, operations);
    }

    //function to receive ether from kyber
    //when you send ether to a smart contract without calling a function you will execute a fallback function - aka a function without any name
    //if a fallback function doesnt exist the transfer of ether will fail
    function() external payable {}
}
