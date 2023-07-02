// Load environment variables
require("dotenv").config()

// Import necessary libraries and contracts
const Web3 = require('web3');
const { ChainId, TokenAmount, Fetcher } = require('@uniswap/sdk');
const abis = require('./abis');
const { mainnet: addresses } = require('./addresses');
const Flashloan = require('./build/contracts/Flashloan.json');

// Instantiate Web3 with Websocket provider
const web3 = new Web3(
    new Web3.providers.WebsocketProvider(process.env.INFURA_URL)
);

// Add the wallet private key
const { address: admin } = web3.eth.accounts.wallet.add(process.env.PRIVATE_KEY);

// Create Kyber network contract instance
const kyber = new web3.eth.Contract(
    abis.kyber.kyberNetworkProxy,
    addresses.kyber.kyberNetworkProxy
);

// Define basic constants
const ONE_WEI = web3.utils.toBN(web3.utils.toWei('1'));
const AMOUNT_DAI_WEI = web3.utils.toBN(web3.utils.toWei('20000'));
const DIRECTION = {
    KYBER_TO_UNISWAP: 0,
    UNISWAP_TO_KYBER: 1
};

// Main function for executing the logic
const init = async () => {
    // Get network ID and create a flashloan contract instance
    const networkId = await web3.eth.net.getId();
    const flashloan = new web3.eth.Contract(
        Flashloan.abi,
        Flashloan.networks[networkId].address
    );

    // Update the ETH price periodically
    let ethPrice;
    const updateEthPrice = async () => {
        const results = await kyber
            .methods
            .getExpectedRate(
                '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
                addresses.tokens.dai,
                1
            )
            .call();
        ethPrice = web3.utils.toBN('1').mul(web3.utils.toBN(results.expectedRate)).div(ONE_WEI);
    }
    await updateEthPrice();
    setInterval(updateEthPrice, 15000);

    // Watch for new blocks and execute arbitrage logic
    web3.eth.subscribe('newBlockHeaders')
        .on('data', async block => {
            console.log(`New block received. Block # ${block.number}`);

            // Get DAI and WETH tokens data using Uniswap SDK and create a pair
            const [dai, weth] = await Promise.all(
                [addresses.tokens.dai, addresses.tokens.weth].map(tokenAddress => (
                    Fetcher.fetchTokenData(
                        ChainId.MAINNET,
                        tokenAddress,
                    )
                )));
            const daiWeth = await Fetcher.fetchPairData(
                dai,
                weth,
            );

            // Calculate expected output amounts for both DEXes
            const amountsEth = await Promise.all([
                kyber
                    .methods
                    .getExpectedRate(
                        addresses.tokens.dai,
                        '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
                        AMOUNT_DAI_WEI
                    )
                    .call(),
                daiWeth.getOutputAmount(new TokenAmount(dai, AMOUNT_DAI_WEI)),
            ]);
            const ethFromKyber = AMOUNT_DAI_WEI.mul(web3.utils.toBN(amountsEth[0].expectedRate)).div(ONE_WEI);
            const ethFromUniswap = web3.utils.toBN(amountsEth[1][0].raw.toString());

            // Calculate expected output for reverse swap
            const amountsDai = await Promise.all([
                kyber
                    .methods
                    .getExpectedRate(
                        '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
                        addresses.tokens.dai,
                        ethFromUniswap.toString()
                    )
                    .call(),
                daiWeth.getOutputAmount(new TokenAmount(weth, ethFromKyber.toString())),
            ]);

            const daiFromKyber = ethFromUniswap.mul(web3.utils.toBN(amountsDai[0].expectedRate)).div(ONE_WEI);
            const daiFromUniswap = web3.utils.toBN(amountsDai[1][0].raw.toString());

            console.log(`Kyber -> Uniswap. Dai input / output: ${web3.utils.fromWei(AMOUNT_DAI_WEI.toString())} / ${web3.utils.fromWei(daiFromUniswap.toString())}`);
            console.log(`Uniswap -> Kyber. Dai input / output: ${web3.utils.fromWei(AMOUNT_DAI_WEI.toString())} / ${web3.utils.fromWei(daiFromKyber.toString())}`);

            // If there is profitable arb opportunity, execute it
            if (daiFromUniswap.gt(AMOUNT_DAI_WEI)) {
                const tx = flashloan.methods.initiateFlashloan(
                    addresses.dydx.solo,
                    addresses.tokens.dai,
                    AMOUNT_DAI_WEI,
                    DIRECTION.KYBER_TO_UNISWAP
                );
                const [gasPrice, gasCost] = await Promise.all([
                    web3.eth.getGasPrice(),
                    tx.estimateGas({ from: admin }),
                ]);

                // Calculate transaction cost and profit
                const txCost = web3.utils.toBN(gasCost).mul(web3.utils.toBN(gasPrice)).mul(ethPrice);
                const profit = daiFromUniswap.sub(AMOUNT_DAI_WEI).sub(txCost);

                // Only execute if profit is more than zero
                if (profit > 0) {
                    console.log('Arb opportunity found Kyber -> Uniswap!');
                    console.log(`Expected profit: ${web3.utils.fromWei(profit)} Dai`);
                    const data = tx.encodeABI();
                    const txData = {
                        from: admin,
                        to: flashloan.options.address,
                        data,
                        gas: gasCost,
                        gasPrice
                    };
                    const receipt = await web3.eth.sendTransaction(txData);
                    console.log(`Transaction hash: ${receipt.transactionHash}`);
                }
            }

            // Repeat the same for Uniswap -> Kyber direction
            if (daiFromKyber.gt(AMOUNT_DAI_WEI)) {
                const tx = flashloan.methods.initiateFlashloan(
                    addresses.dydx.solo,
                    addresses.tokens.dai,
                    AMOUNT_DAI_WEI,
                    DIRECTION.UNISWAP_TO_KYBER
                );
                const [gasPrice, gasCost] = await Promise.all([
                    web3.eth.getGasPrice(),
                    tx.estimateGas({ from: admin }),
                ]);
                const txCost = web3.utils.toBN(gasCost).mul(web3.utils.toBN(gasPrice)).mul(ethPrice);
                const profit = daiFromKyber.sub(AMOUNT_DAI_WEI).sub(txCost);

                if (profit > 0) {
                    console.log('Arb opportunity found Uniswap -> Kyber!');
                    console.log(`Expected profit: ${web3.utils.fromWei(profit)} Dai`);
                    const data = tx.encodeABI();
                    const txData = {
                        from: admin,
                        to: flashloan.options.address,
                        data,
                        gas: gasCost,
                        gasPrice
                    };
                    const receipt = await web3.eth.sendTransaction(txData);
                    console.log(`Transaction hash: ${receipt.transactionHash}`);
                }
            }
        })
        .on('error', error => {
            console.log(error);
        });
}
init();