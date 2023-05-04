//need our smart contract
const Flashloan = artifacts.require("Flashloan.sol");
const { mainnet: addresses } = require('../addresses');

//module_exports has an array of addresses - it is the address we added in truffle config with the private key, can also add an array of private key in truffle config
//also in config you can add multiple beneficiaryAddresses

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