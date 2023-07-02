//need our smart contract
const Flashloan = artifacts.require("Flashloan.sol");
// rename exported mainnet key to addresses
const { mainnet: addresses } = require('../addresses');

//module_exports has an array of addresses - it is the address we added in truffle config with the private key, can also add an array of private key in truffle config - we destrucutred to get the first one
//also in config you can add multiple beneficiaryAddresses


// deploy smart contracts - provide arguments to deploy - need address of kyber uniswap weth and dai

module.exports = function (deployer, _network, [beneficiaryAddress, _]) {
    //deploy our smart contract - remember our SC has arguments in constructor in which we can provide here
    deployer.deploy(
        Flashloan,
        addresses.kyber.kyberNetworkProxy,
        addresses.uniswap.router,
        addresses.tokens.weth,
        addresses.tokens.dai,
        beneficiaryAddress
    );
};

// deploy our smart contract - send eth to deploying contract - aka private key
// truffle migrate --network maiinet --reset
// contract address - 0x7723Df76820b2757c8B08A781fAbee2bA4d78A63
// transaction hash: 0x650972c2d1dc4f9e8ea66478eaed20e459a97c33ccc055f3c247e8500265ecf6
// https://trufflesuite.com/docs/truffle/how-to/contracts/run-migrations/