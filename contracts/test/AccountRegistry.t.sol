// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {Fixture} from "./Fixture.sol";
import {BasketAccount} from "../src/BasketAccount.sol";
import {BasketAccountFactory} from "../src/BasketAccountFactory.sol";
import {MarketRegistry} from "../src/MarketRegistry.sol";
import {BasketRouter} from "../src/BasketRouter.sol";
import {IntentTypes} from "../src/IntentTypes.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

contract MockSmartOwner is IERC1271 {
    address immutable signer;

    constructor(address s) {
        signer = s;
    }

    function isValidSignature(bytes32 digest, bytes memory signature) public view returns (bytes4) {
        return SignatureChecker.isValidSignatureNow(signer, digest, signature)
            ? IERC1271.isValidSignature.selector
            : bytes4(0xffffffff);
    }
}

contract AccountRegistryTest is Fixture {
    function test_FactoryAddressPredictionAndOwnerScopedSalt() public {
        bytes32 salt = keccak256("another basket");
        address predicted = factory.predictAccount(owner, salt);
        vm.prank(owner);
        address created = factory.createAccount(salt);
        require(created == predicted && factory.isAccount(created), "prediction");
        require(BasketAccount(payable(created)).owner() == owner, "owner");
        require(factory.predictAccount(address(this), salt) != predicted, "owner scoped");
        vm.expectRevert();
        vm.prank(owner);
        factory.createAccount(salt);
    }

    function test_SmartWalletOwnerSignatureAndRevocation() public {
        MockSmartOwner smart = new MockSmartOwner(owner);
        address[] memory allowed = new address[](2);
        allowed[0] = address(pools[0]);
        allowed[1] = address(pools[1]);
        vm.prank(address(smart));
        account = BasketAccount(payable(factory.createAccount(keccak256("smart owner"))));
        token.mint(address(account), 1000e18);
        vm.prank(address(smart));
        account.depositMargin(1000e18);
        vm.prank(address(smart));
        account.setRouterApproval(address(router), allowed, true);
        _execute(_intent(2));
        require(bank.getActivePerpPools(address(account)).length == 2, "smart signature");
    }

    function test_WithdrawMarginPreservesOwnershipAndInvalidatesIntent() public {
        uint256 beforeRevision = account.revision();
        uint256 beforeEpoch = account.epoch();
        uint256 beforeOwner = token.balanceOf(owner);
        vm.prank(owner);
        account.withdrawMargin(50e18);
        require(bank.balance(address(account)) == 950e18, "bank amount");
        require(token.balanceOf(owner) == beforeOwner + 50e18, "owner receives");
        require(account.revision() == beforeRevision + 1 && account.epoch() == beforeEpoch + 1, "invalidated");
    }

    function test_OwnerOnlyAccountAdministration() public {
        vm.expectRevert(BasketAccount.Unauthorized.selector);
        account.depositMargin(1);
        vm.expectRevert(BasketAccount.Unauthorized.selector);
        account.withdrawMargin(1);
        vm.expectRevert(BasketAccount.Unauthorized.selector);
        account.withdrawToken(address(token), 1);
        vm.expectRevert(BasketAccount.Unauthorized.selector);
        account.withdrawNative(1);
        vm.expectRevert(BasketAccount.Unauthorized.selector);
        account.invalidateIntents();
        vm.expectRevert(BasketAccount.Unauthorized.selector);
        account.recordExecution(1);
        vm.expectRevert(BasketAccount.Unauthorized.selector);
        account.cancelOrder(address(pools[0]), 1);
    }

    function test_OwnerCanRecoverUndepositedTokenAndGas() public {
        token.mint(address(account), 3e18);
        vm.prank(owner);
        account.withdrawToken(address(token), 3e18);
        require(token.balanceOf(owner) == 3e18, "token recover");
        vm.deal(address(account), 1 ether);
        uint256 beforeBalance = owner.balance;
        vm.prank(owner);
        account.withdrawNative(1 ether);
        require(owner.balance == beforeBalance + 1 ether, "gas recover");
    }

    function test_ZeroAmountAndInvalidPoolRejected() public {
        vm.expectRevert(BasketAccount.InvalidArgument.selector);
        vm.prank(owner);
        account.depositMargin(0);
        vm.expectRevert(BasketAccount.InvalidArgument.selector);
        vm.prank(owner);
        account.withdrawMargin(0);
        vm.expectRevert(BasketAccount.InvalidArgument.selector);
        vm.prank(owner);
        account.withdrawToken(address(token), 0);
        vm.expectRevert(BasketAccount.InvalidMarket.selector);
        vm.prank(owner);
        account.cancelOrder(address(0xBAD), 1);
        address[] memory allowed = new address[](0);
        vm.expectRevert(BasketAccount.InvalidArgument.selector);
        vm.prank(owner);
        account.setRouterApproval(address(router), allowed, true);
        allowed = new address[](1);
        allowed[0] = address(0xBAD);
        vm.expectRevert(BasketAccount.InvalidMarket.selector);
        vm.prank(owner);
        account.setRouterApproval(address(router), allowed, true);
        vm.expectRevert(BasketAccount.InvalidRouter.selector);
        vm.prank(owner);
        account.setRouterApproval(address(0xBAD), allowed, true);
    }

    function test_GrantRevocationBlocksStandingIntentAndPoolAccess() public {
        IntentTypes.Intent memory intent = _intent(2);
        address[] memory allowed = new address[](1);
        allowed[0] = address(pools[0]);
        vm.prank(owner);
        account.setRouterApproval(address(router), allowed, false);
        _expect(intent, BasketRouter.Unauthorized.selector);
        require(!permissions.approved(address(account), address(pools[0]), address(router)), "pool revoked");
    }

    function test_EmergencyExitWorksWhileEntryPaused() public {
        _execute(_intent(2));
        markets.pauseEntry();
        uint256 quantity = pools[0].base() / 10;
        uint64 expiry = uint64((block.timestamp + 60) * 1e9);
        vm.prank(owner);
        account.emergencyClose(address(pools[0]), quantity, 100e18, expiry, false);
        require(bank.getPosition(address(account), address(pools[0])).size == 0, "emergency flat");
        require(bank.getActivePerpPools(address(account)).length == 1, "other remains");
    }

    function test_EmergencyIocAcceptsPartialButFokDoesNot() public {
        _execute(_intent(2));
        pools[0].setPartial(true);
        uint256 quantity = pools[0].base() / 10;
        uint64 expiry = uint64((block.timestamp + 60) * 1e9);
        vm.expectRevert(BasketAccount.NotFilled.selector);
        vm.prank(owner);
        account.emergencyClose(address(pools[0]), quantity, 100e18, expiry, false);
        vm.prank(owner);
        account.emergencyClose(address(pools[0]), quantity, 100e18, expiry, true);
        require(
            bank.getPosition(address(account), address(pools[0])).size == int128(int256(quantity / 2)), "partial IOC"
        );
    }

    function test_EmergencyCannotOvercloseOrUseExpiredOrder() public {
        _execute(_intent(2));
        uint256 quantity = pools[0].base() / 10;
        uint64 expiry = uint64((block.timestamp + 60) * 1e9);
        vm.expectRevert(BasketAccount.InvalidClose.selector);
        vm.prank(owner);
        account.emergencyClose(address(pools[0]), quantity + 1, 100e18, expiry, false);
        vm.expectRevert(BasketAccount.InvalidArgument.selector);
        vm.prank(owner);
        account.emergencyClose(address(pools[0]), quantity, 100e18, 1, false);
        vm.expectRevert(BasketAccount.InvalidMarket.selector);
        vm.prank(owner);
        account.emergencyClose(address(0xBAD), quantity, 100e18, expiry, false);
    }

    function test_CancelOrderInvalidatesExistingIntent() public {
        IntentTypes.Intent memory intent = _intent(2);
        vm.prank(owner);
        account.cancelOrder(address(pools[0]), 1);
        _expect(intent, BasketRouter.StaleState.selector);
    }

    function test_GovernorAndGuardianAreDifferentCapabilities() public {
        markets.setGuardian(owner);
        vm.prank(owner);
        markets.pauseEntry();
        vm.expectRevert(MarketRegistry.Unauthorized.selector);
        vm.prank(owner);
        markets.resumeEntry();
        vm.expectRevert(MarketRegistry.Unauthorized.selector);
        vm.prank(owner);
        markets.configurePool(address(pools[0]), false);
        vm.expectRevert(MarketRegistry.InvalidConfiguration.selector);
        markets.setGuardian(address(0));
        vm.expectRevert(MarketRegistry.Unauthorized.selector);
        vm.prank(executor);
        markets.pauseEntry();
        markets.resumeEntry();
        require(!markets.entryPaused(), "governor resume");
    }

    function test_UnverifiedAndInvalidFeePoolsCannotActivate() public {
        vm.expectPartialRevert(MarketRegistry.InvalidMarket.selector);
        markets.configurePool(address(0xBAD), true);
        pools[0].setFee(10_000_000);
        vm.expectPartialRevert(MarketRegistry.InvalidMarket.selector);
        markets.configurePool(address(pools[0]), true);
        vm.expectPartialRevert(MarketRegistry.InvalidMarket.selector);
        markets.marketMetadata(address(0xBAD));
        require(markets.verifiedPools().length == 9, "registered list");
    }

    function test_InvalidDeploymentConfigurationRejected() public {
        vm.expectRevert(MarketRegistry.InvalidConfiguration.selector);
        new MarketRegistry(address(0), address(protocolFactory), address(token), address(this), address(this));
        bank.setWired(false);
        vm.expectRevert(MarketRegistry.InvalidConfiguration.selector);
        new MarketRegistry(address(bank), address(protocolFactory), address(token), address(this), address(this));
        vm.expectRevert(BasketAccountFactory.InvalidConfiguration.selector);
        new BasketAccountFactory(address(0), address(token), address(permissions), address(markets));
    }
}
