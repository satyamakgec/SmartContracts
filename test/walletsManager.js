const Wallet = artifacts.require('./Wallet.sol')
const FakeCoin = artifacts.require("./FakeCoin.sol")
const ChronoBankAssetProxy = artifacts.require("./ChronoBankAssetProxy.sol")
const bytes32 = require('./helpers/bytes32')
const Setup = require('../setup/setup')
const eventsHelper = require('./helpers/eventsHelper')
const MultiEventsHistory = artifacts.require('./MultiEventsHistory.sol')
const ErrorsEnum = require("../common/errors")
const Clock = artifacts.require('./Clock.sol')
const TimeMachine = require('./helpers/timemachine');

contract('Wallets Manager', function(accounts) {
    let owner = accounts[0]
    let owner1 = accounts[1]
    let owner2 = accounts[2]
    let owner3 = accounts[3]
    let owner4 = accounts[4]
    let owner5 = accounts[5]
    let nonOwner = accounts[6]
    let wallet
    let wallet2FA
    let txId
    let watcher
    let clock
    let coin
    let eventor
    let unix = Math.round(+new Date()/1000)
    let timeMachine = new TimeMachine(web3);

    before('setup', function(done) {
        Wallet.at(MultiEventsHistory.address).then((instance) => {
            eventor = instance
            return Clock.deployed()
            .then(_clock => clock = _clock)
        })
        Setup.setup(done)
    })

    const SYMBOL = 'TOKEN';

    context("initial tests", function() {

        it("Token and balances initialization should pass.", function () {
            return FakeCoin.deployed().then(function (instance) {
                coin = instance
                return Wallet.new([owner,owner1], 2, Setup.contractsManager.address, false, 0).then(function (instance) {
                    wallet = instance
                    return Setup.multiEventsHistory.authorize(wallet.address).then(function () {
                        return Setup.erc20Manager.addToken(coin.address, SYMBOL, SYMBOL, '0x1', 2, '0x1', '0x1', {
                            from: owner,
                            gas: 3000000
                        }).then(function (tx) {
                            return coin.mint(accounts[0], 10000).then(() => {
                                return coin.mint(wallet.address, 10000)
                            }).then(() => {
                                web3.eth.sendTransaction({to: wallet.address, value: 10000, from: accounts[0]})
                                balanceETH = web3.eth.getBalance(wallet.address)
                                assert.equal(balanceETH, 10000)
                                return coin.balanceOf.call(wallet.address).then((balanceERC20) => {
                                    assert.equal(balanceERC20, 10000)
                                })
                            })
                        })
                    })
                })
            })
        })

    })

    context("CRUD test", async () => {

        it("can create new MultiSig Wallet contract", async () => {
            let resultCode = await Setup.walletsManager.createWallet.call([owner,owner1],2, 0);
            assert.equal(resultCode, ErrorsEnum.OK);

            let createWalletTx = await Setup.walletsManager.createWallet([owner,owner1],2, 0);
            let walletCreatedEvents = eventsHelper.extractEvents(createWalletTx, "WalletCreated");
            assert.equal(walletCreatedEvents.length, 1);

            let walletAddress = walletCreatedEvents[0].args.wallet;
            let wallet = await Wallet.at(walletAddress);

            let m_required = await wallet.m_required.call();
            assert.equal(m_required, 2);

            let m_numOwners = await wallet.m_numOwners.call();
            assert.equal(m_numOwners, 2);
        })

        it('should be able to multisig send ETH', function() {
            eventsHelper.setupEvents(eventor)
            watcher = eventor.MultisigWalletConfirmationNeeded()
            balanceETH = web3.eth.getBalance(wallet.address)
            return wallet.transfer.call(owner3, 5000, 'ETH').then(function (r) {
                return wallet.transfer(owner3, 5000, 'ETH').then(function (tx) {
                    return eventsHelper.getEvents(tx, watcher)
                }).then(function (events) {
                    assert.notEqual(events.length, 0)
                    const confirmationHash = events[0].args.operation
                    const old_balance = web3.eth.getBalance(owner3)
                    return wallet.confirm.call(confirmationHash, {from: owner1}).then(function (r2) {
                        return wallet.confirm(confirmationHash, {from: owner1}).then(function () {
                            assert.equal(r, 14014)
                            assert.equal(r2, 1)
                            const new_balance = web3.eth.getBalance(owner3)
                            assert.isTrue(new_balance.equals(old_balance.add(5000)))
                        })
                    })
                })
            })
        })

        it("shouldn't be able to multisig send ETH if balance not enough", async () => {
          let balance  = web3.eth.getBalance(wallet.address);
          let r = await wallet.transfer.call(owner3, 500000000000000 + 1, "ETH");
          assert.equal(r, 14019)
        })

        it("should be able to multisig send ERC20", function() {
            return wallet.transfer.call(owner3,5000,SYMBOL, {from: owner}).then(function(r) {
                return wallet.transfer(owner3,5000,SYMBOL, {from: owner}).then(function(tx) {
                    return eventsHelper.getEvents(tx, watcher)
                }).then(function (events) {
                    assert.notEqual(events.length, 0)
                    const confirmationHash = events[0].args.operation
                    return wallet.confirm.call(confirmationHash, {from:owner1}).then(function(r2) {
                        return wallet.confirm(confirmationHash, {from:owner1}).then(function() {
                            return coin.balanceOf.call(owner3).then(function(r3)
                            {
                                assert.equal(r, 14014)
                                assert.equal(r2, 1)
                                assert.equal(r3, 5000)
                            })
                        })
                    })
                })
            })
        })

        it("shouldn't be able to multisig send ERC20 if balance no enough", async () => {
            let r = await wallet.transfer.call(owner3, 6000, SYMBOL, {from: wallet.address});
            assert.equal(r, ErrorsEnum.WALLET_INSUFFICIENT_BALANCE);
        })

        it("should multisig change owner", async () => {
          assert.isTrue(await wallet.isOwner.call(owner1));
          assert.isFalse(await wallet.isOwner.call(owner2));

          let tx = await wallet.changeOwner(owner1, owner2);
          let events = eventsHelper.extractEvents(tx, "MultisigWalletConfirmationNeeded");
          assert.equal(events.length, 1);

          let operation = events[0].args.operation;

          await wallet.confirm(operation, {from: owner1});

          assert.isFalse(await wallet.isOwner.call(owner1));
          assert.isTrue(await wallet.isOwner.call(owner2));
        })

        it("should multisig add owner", async () => {
          assert.isTrue(await wallet.isOwner.call(owner));
          assert.isFalse(await wallet.isOwner.call(owner1));
          assert.isTrue(await wallet.isOwner.call(owner2));

          let tx = await wallet.addOwner(owner1);
          let operation = getOperationFromMultisigTx(tx);

          await wallet.confirm(operation, {from: owner2});

          assert.isTrue(await wallet.isOwner.call(owner));
          assert.isTrue(await wallet.isOwner.call(owner1));
          assert.isTrue(await wallet.isOwner.call(owner2));
        })

        it("should multisig change requirement", async () => {
          let m_required = await wallet.m_required.call();
          const new_m_required = 3;
          assert.notEqual(new_m_required, m_required);

          let tx = await wallet.changeRequirement(new_m_required);
          let operation = getOperationFromMultisigTx(tx);

          await wallet.confirm(operation, {from: owner2});

          assert.equal(new_m_required, await wallet.m_required.call());
        })


        it("should multisig kill and transfer funds", async () => {
            let createWalletTx = await Setup.walletsManager.createWallet([owner,owner1, owner2], 3, 0);
            let walletCreatedEvents = eventsHelper.extractEvents(createWalletTx, "WalletCreated");
            assert.equal(walletCreatedEvents.length, 1);

            let walletAddress = walletCreatedEvents[0].args.wallet;
            let wallet = await Wallet.at(walletAddress);

            let wallet_erc20_balance = await coin.balanceOf.call(wallet.address);
            const wallet_eth_balance = web3.eth.getBalance(wallet.address);
            const old_balance = web3.eth.getBalance(owner4);

            assert.equal(3, await wallet.m_required.call());

            assert.isTrue(await wallet.isOwner.call(owner));
            assert.isTrue(await wallet.isOwner.call(owner1));
            assert.isTrue(await wallet.isOwner.call(owner2));

            let killTx = await wallet.kill(owner4, {from: owner});
            let operation = getOperationFromMultisigTx(killTx);

            await wallet.confirm(operation, {from: owner1});
            await wallet.confirm(operation, {from: owner2});

            assert.isTrue(wallet_erc20_balance.equals(await coin.balanceOf.call(owner4)));
            const new_balance = web3.eth.getBalance(owner4);
            assert.isTrue(new_balance.equals(old_balance.add(wallet_eth_balance)));
        })

        it("should allow to set multisig oracle address for owner", function() {
            return Setup.walletsManager.setOracleAddress.call(owner2).then(function (r) {
                return Setup.walletsManager.setOracleAddress(owner2, {
                    from: owner,
                    gas: 3000000
                }).then(function (tx) {
                    return Setup.walletsManager.getOracleAddress.call().then(function (r2) {
                        assert.equal(r,ErrorsEnum.OK)
                        assert.equal(r2, owner2)
                    })
                })
            })
        })

        it("shouldn't allow to set multisig oracle address for nonowner", function() {
            return Setup.walletsManager.setOracleAddress.call(owner3).then(function (r) {
                return Setup.walletsManager.setOracleAddress(owner3, {
                    from: owner1,
                    gas: 3000000
                }).then(function (tx) {
                    return Setup.walletsManager.getOracleAddress.call().then(function (r2) {
                        assert.equal(r,ErrorsEnum.OK)
                        assert.equal(r2, owner2)
                    })
                })
            })
        })

        it("should allow to set multisig oracle price for owner", function() {
            return Setup.walletsManager.setOraclePrice.call(10).then(function (r) {
                return Setup.walletsManager.setOraclePrice(10, {
                    from: owner,
                    gas: 3000000
                }).then(function (tx) {
                    return Setup.walletsManager.getOraclePrice.call().then(function (r2) {
                        assert.equal(r,ErrorsEnum.OK)
                        assert.equal(r2, 10)
                    })
                })
            })
        })

        it("shouldn't allow to set multisig oracle price for nonowner", function() {
            return Setup.walletsManager.setOraclePrice.call(20).then(function (r) {
                return Setup.walletsManager.setOraclePrice(20, {
                    from: owner1,
                    gas: 3000000
                }).then(function (tx) {
                    return Setup.walletsManager.getOraclePrice.call().then(function (r2) {
                        assert.equal(r,ErrorsEnum.OK)
                        assert.equal(r2, 10)
                    })
                })
            })
        })

        it("can create new 2FA Wallet contract", function() {
            return Setup.walletsManager.create2FAWallet.call(0).then(function(r1) {
                return Setup.walletsManager.create2FAWallet(0, {
                    from: owner,
                    gas: 3000000
                }).then((tx) => {
                    const walletCreatedEvents = eventsHelper.extractEvents(tx, "WalletCreated")
                    assert.notEqual(walletCreatedEvents.length, 0)
                    const walletAddress = walletCreatedEvents[0].args.wallet
                    wallet2FA = walletAddress;
                    return Wallet.at(walletAddress).then(function(instance) {
                        return instance.m_required.call().then(function(r2) {
                            return instance.m_numOwners.call().then(function(r3) {
                                assert.equal(r1, ErrorsEnum.OK)
                                assert.equal(r2, 2)
                                assert.equal(r3, 2)
                            })
                        })
                    })
                })
            })
        })

        it("can't add owner to 2FA Wallet", function() {
            return Wallet.at(wallet2FA).then(function(instance) {
                return instance.addOwner.call(owner1).then(function (r) {
                    assert.equal(r, 14010)
                })
            })
        })

        it("can't change owner to 2FA Wallet", function() {
            return Wallet.at(wallet2FA).then(function(instance) {
                return instance.changeOwner.call(owner2, owner3).then(function (r) {
                    assert.equal(r, 14010)
                })
            })
        })

        it("can't remove owner to 2FA Wallet", function() {
            return Wallet.at(wallet2FA).then(function(instance) {
                return instance.removeOwner.call(owner1).then(function (r) {
                    assert.equal(r, 14010)
                })
            })
        })

        it("can't change requirement for 2FA Wallet", function() {
            return Wallet.at(wallet2FA).then(function(instance) {
                return instance.changeRequirement.call(owner1).then(function (r) {
                    assert.equal(r, 14010)
                })
            })
        })

        it("should perform 2FA transfer", async () => {
            const oracle = owner1;
            const oracleBalance = web3.eth.getBalance(owner1);
            const targetBalance = web3.eth.getBalance(owner3);

            await Setup.walletsManager.setOracleAddress(oracle);
            assert.equal(oracle, await Setup.walletsManager.getOracleAddress());

            await Setup.walletsManager.setOraclePrice(10);
            assert.equal(10, await Setup.walletsManager.getOraclePrice());

            let createWalletTx = await Setup.walletsManager.create2FAWallet(0);
            const walletCreatedEvents = eventsHelper.extractEvents(createWalletTx, "WalletCreated");
            assert.equal(walletCreatedEvents.length, 1);
            const walletAddress = walletCreatedEvents[0].args.wallet;

            let wallet = Wallet.at(walletAddress);

            web3.eth.sendTransaction({to: walletAddress, value: 10000, from: accounts[0]});

            assert.isTrue(await wallet.isOwner.call(owner));
            assert.isTrue(await wallet.isOwner.call(oracle));

            assert.equal(2, await wallet.m_numOwners.call());
            assert.equal(2, await wallet.m_required.call());

            let transferTx = await wallet.transfer(owner3, 10, 'ETH', {value: 10});
            let operation = getOperationFromMultisigTx(transferTx);

            assert.equal(web3.eth.getBalance(oracle).sub(oracleBalance), 10);

            await wallet.confirm(operation, {from: oracle});
            assert.equal(web3.eth.getBalance(owner3).sub(targetBalance), 10);
        })

        it("can create timelocked Wallet contract", async () => {
            let currentTime = await clock.time.call();
            console.log("Testrpc current date:", secondsToDate(currentTime));

            let currentDate = secondsToDate(currentTime);
            currentDate.setMonth(currentDate.getMonth() + 5);

            let createWalletResult = await Setup.walletsManager.createWallet.call([owner], 1, currentDate.valueOf() / 1000);
            assert.equal(createWalletResult, ErrorsEnum.OK);

            let createWalletTx =
              await Setup.walletsManager.createWallet([owner], 1, currentDate.valueOf() / 1000, {from: owner,gas: 3000000});

            const walletCreatedEvents = eventsHelper.extractEvents(createWalletTx, "WalletCreated");
            assert.notEqual(walletCreatedEvents.length, 0);

            const walletAddress = walletCreatedEvents[0].args.wallet;
            web3.eth.sendTransaction({to: walletAddress, value: 10000, from: accounts[0]});

            let balanceETH = web3.eth.getBalance(walletAddress);
            assert.equal(balanceETH, 10000);

            let wallet = Wallet.at(walletAddress);
            assert.equal(1, await wallet.m_required.call());
            assert.equal(1, await wallet.m_numOwners.call());
            assert.equal(currentDate.valueOf() / 1000, await wallet.releaseTime.call());

            currentDate.setMonth(currentDate.getMonth() + 1);

            await timeMachine.jump(currentDate.getTime() / 1000 - currentTime);

            transferResult = await wallet.transfer.call(owner3, 6000, 'ETH');
            assert.equal(ErrorsEnum.OK, transferResult);
        });

        it("should withdraw random ERC20 token", async () => {

            let createWalletTx = await Setup.walletsManager.createWallet([owner], 1, 0);
            const walletCreatedEvents = eventsHelper.extractEvents(createWalletTx, "WalletCreated");
            assert.equal(walletCreatedEvents.length, 1);
            const walletAddress = walletCreatedEvents[0].args.wallet;

            let wallet = Wallet.at(walletAddress);

            let token1 = await FakeCoin.new();
            await token1.mint(wallet.address, 1001);

            let token2 = await FakeCoin.new();
            await token2.mint(wallet.address, 1002);

            assert.equal(await token1.balanceOf(wallet.address), 1001);
            assert.equal(await token1.balanceOf(owner), 0);

            assert.equal(await token2.balanceOf(wallet.address), 1002);
            assert.equal(await token2.balanceOf(owner), 0);

            await wallet.withdrawnTokens([token1.address, token2.address], owner);
            assert.equal(await token1.balanceOf(owner), 1001);
            assert.equal(await token2.balanceOf(owner), 1002);
        })
    })
})

let secondsToDate = (seconds) => {
    var t = new Date(1970, 0, 1); t.setSeconds(seconds);
    return t;
}

let getOperationFromMultisigTx = (tx) => {
  let events = eventsHelper.extractEvents(tx, "MultisigWalletConfirmationNeeded");
  assert.equal(events.length, 1);
  return events[0].args.operation;
}
