require('dotenv').config()
const Web3 = require('web3');
const { ChainId, Token, TokenAmount, Pair, Fetcher } = require('@uniswap/sdk');
const abis = require('./abis');
const { mainnet: addresses } = require('./addresses');

//import from builds the flashloan json document
const Flashloan = require('./build/contracts/Flashloan.json');

const web3 = new Web3(
    new Web3.providers.WebsocketProvider(process.env.INFURA_URL)
);

const { address: admin } = web3.eth.accounts.wallet.add(process.env.PRIVATE_KEY);

const kyber = new web3.eth.Contract(
    abis.kyber.kyberNetworkProxy,
    addresses.kyber.kyberNetworkProxy
);

const AMOUNT_ETH = 100;
const RECENT_ETH_PRICE = 230;
const AMOUNT_ETH_WEI = web3.utils.toWei(AMOUNT_ETH.toString());
const AMOUNT_DAI_WEI = web3.utils.toWei((AMOUNT_ETH * RECENT_ETH_PRICE).toString());
const DIRECTION = {
    KYBER_TO_UNISWAP: 0,
    UNISWAP_TO_KYBER: 1
}
const init = async () => {
    //create a web3 object that points to our flashloan
    //we need the chain id which represents the eth network we are connected to 
    const networkId = await web3.eth.net.getId();
    const flashloan = new web3.eth.Contract(
        Flashloan.abi,
        Flashloan.networks[networkId].address
    );
    const [dai, weth] = await Promise.all(
        [addresses.tokens.dai, addresses.tokens.weth].map(tokenAddress => (
            Fetcher.fetchTokenData(
                ChainId.MAINNET,
                tokenAddress,
            )
        )));
    const daiWeth = await Fetcher.fetchPairData(
        dai,
        weth
    );

    web3.eth.subscribe('newBlockHeaders')
        .on('data', async block => {
            console.log(`New block received. Block # ${block.number}`);

            const kyberResults = await Promise.all([
                kyber
                    .methods
                    .getExpectedRate(
                        addresses.tokens.dai,
                        '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
                        AMOUNT_DAI_WEI
                    )
                    .call(),
                kyber
                    .methods
                    .getExpectedRate(
                        '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
                        addresses.tokens.dai,
                        AMOUNT_ETH_WEI
                    )
                    .call()
            ]);
            const kyberRates = {
                buy: parseFloat(1 / (kyberResults[0].expectedRate / (10 ** 18))),
                sell: parseFloat(kyberResults[1].expectedRate / (10 ** 18))
            };
            console.log('Kyber ETH/DAI');
            console.log(kyberRates);

            const uniswapResults = await Promise.all([
                daiWeth.getOutputAmount(new TokenAmount(dai, AMOUNT_DAI_WEI)),
                daiWeth.getOutputAmount(new TokenAmount(weth, AMOUNT_ETH_WEI))
            ]);

            const uniswapRates = {
                buy: parseFloat(AMOUNT_DAI_WEI / (uniswapResults[0][0].toExact() * 10 ** 18)),
                sell: parseFloat(uniswapResults[1][0].toExact() / AMOUNT_ETH)
            }

            console.log('Uniswap ETH/DAI');
            console.log(uniswapRates);

            //build two transactions and estimate the transaction cost
            //web3.js contract .method creates a transaction object for that method which can be called sent, etc etc
            const [tx1, tx2] = Object.keys(DIRECTION).map(direction => flashloan.methods.initiateFlashloan(
                addresses.dydx.solo,
                addresses.tokens.dai,
                AMOUNT_DAI_WEI,
                DIRECTION[direction]
            ));

            const [gasPrice, gasCost1, gasCost2] = awaitPromise.all([
                web3.eth.getGasPrice(),
                tx1.estimateGas({ from: admin }),
                tx2.estimateGas({ from: admin })
            ]);

            const txCost1 = parseInt(gasCost1) * parseInt(gasPrice);
            const txCost2 = parseInt(gasCost2) * parseInt(gasPrice);
            //whats the current eth price? Take average between buy and sell price of unsiwap
            const currentEthPrice = (uniswapRates.buy + uniswapRates.sell) / 2;
            //profit if buy eth on kyber and sell on uniswap
            const profit1 = (parseInt(AMOUNT_ETH_WEI) / 10 ** 18) * (uniswapRates.sell - kyberRates.buy) - (txCost1 / 10 ** 18) * currentEthPrice;
            //profit if buy eth on uniswap and sell on kyber
            const profit2 = (parseInt(AMOUNT_ETH_WEI) / 10 ** 18) * (kyberRates.sell - uniswapRates.buy) - (txCost2 / 10 ** 18) * currentEthPrice;
            if (profit1 > 0) {
                //we have an arbing oppurtunity
                console.log('Arb oppurtunity found');
                console.log(`Buy ETH on kyber at ${kyberRates.buy} dai`);
                console.log(`Sell ETH on Uniswap at ${uniswapRates.sell} dai`);
                console.log(`Expected profit: ${profit1} dai`);
                //send a transaction
                //need to build the data parameter aka which function with which args will we call
                const data = tx1.encodeABI();
                const txData = {
                    from: admin,
                    to: flashloan.options.address,
                    data,
                    gas: gasCost1,
                    gasPrice
                };
                const receipt = await web3.eth.sendTransaction(txData);
                console.log(`Transaction hash: ${receipt.transactionHash}`)
            } else if (profit2 > 0) {
                console.log('Arb oppurtunity found');
                console.log(`Buy ETH on Uniswap at ${uniswapRates.buy} dai`);
                console.log(`Sell ETH on Kyber at ${kyberRates.sell} dai`);
                console.log(`Expected profit: ${profit2} dai`);
                const data = tx2.encodeABI();

                const txData = {
                    from: admin,
                    to: flashloan.options.address,
                    data,
                    gas: gasCost2,
                    gasPrice
                };
                const receipt = await web3.eth.sendTransaction(txData);
                console.log(`Transaction hash: ${receipt.transactionHash}`)
            }
        })
        .on('error', error => {
            console.log(error);
        });
}
init();

/*
General Notes from Profitable Flashloans course

TRUFFLE: 
Truffle is a smart contract framework
Use truffle init . to initialize a truffle project in the current directory
It will add a contracts folder .. this is where we put our smart contracts
Migrations folder - We will write our migration file which will tell truffle how to deploy to ethereum blockchain
Tests folder lets us write some tests 
the truffle-config file lets us tweak the truggle config
after deploying smart contract truffle has json files in the build subdirectory that you can check out
there will be one for the smart contract you deployed which will have its Abi and it will show the address inside the networks key

FLASHLOANS
-flashloan smart contract will do arb
-dydx doesnt have flashloans explicity but implicity yes since it doesnt check balance until transaction completion
-dydx use withdraw action to borrow a flashloan, call a function on the same sc, use a deposit function to return flashloan, dydx doesnt check balances until the very end of the transaction
-moneylegos good npm package - https://www.npmjs.com/package/@studydefi/money-legos
-need to get solidity pointers to addresses of uniswap and kyber pair contracts for whichever tokens we are interacting with
-need v2router.sol contracts 
-always look at documentation

DEPLOYING FLASHLOAN SC TO MAINNET
1. Configure Truffle to deploy to mainnet npm install @truffle/hdwallet-provider in the root of the project - this allows us to add our private keys to the deployment system of truffle
2. Create a migration file to tell truffle how to deploy our flashloan
3. We will run the migration - js files that help you deploy contracts to the ethereum network
after setting everything up deploy via command truffle migrate --network mainnet --reset






*/