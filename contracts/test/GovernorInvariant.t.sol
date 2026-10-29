// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {SpreadLockGovernor} from "../src/SpreadLockGovernor.sol";
import {Fixture} from "./Fixture.sol";
import {IntentTypes} from "../src/IntentTypes.sol";
import {IDreamBank} from "../src/interfaces/IDreamDex.sol";

interface ExtraVm {
    function expectRevert() external;
}

contract GovernedValue {
    uint256 public value;

    function set(uint256 next) external {
        value = next;
    }
}

contract MockMultisig {
    function getThreshold() external pure returns (uint256) {
        return 2;
    }

    function getOwners() external pure returns (address[] memory a) {
        a = new address[](3);
        a[0] = address(1);
        a[1] = address(2);
        a[2] = address(3);
    }
}

contract GovernorTest is Fixture {
    function test_GovernanceEnforcesDelayAndProposer() public {
        address multisig = address(new MockMultisig());
        SpreadLockGovernor g = new SpreadLockGovernor(multisig);
        GovernedValue v = new GovernedValue();
        bytes memory data = abi.encodeCall(v.set, (77));
        bytes32 salt = keccak256("change");
        vm.expectRevert();
        g.schedule(address(v), 0, data, bytes32(0), salt, 48 hours);
        vm.prank(multisig);
        g.schedule(address(v), 0, data, bytes32(0), salt, 48 hours);
        vm.expectRevert();
        vm.prank(multisig);
        g.execute(address(v), 0, data, bytes32(0), salt);
        vm.warp(block.timestamp + 48 hours);
        vm.prank(multisig);
        g.execute(address(v), 0, data, bytes32(0), salt);
        require(v.value() == 77, "governance execution");
        vm.expectRevert();
        vm.prank(multisig);
        g.execute(address(v), 0, data, bytes32(0), salt);
    }

    function test_GovernorRejectsZeroMultisig() public {
        vm.expectRevert();
        new SpreadLockGovernor(address(0));
    }
}

contract BasketInvariantTest is Fixture {
    struct FuzzSelector {
        address addr;
        bytes4[] selectors;
    }
    bool public broken;
    uint256 private nextNonce = 100;

    function targetContracts() external view returns (address[] memory a) {
        a = new address[](1);
        a[0] = address(this);
    }

    function targetSelectors() external view returns (FuzzSelector[] memory a) {
        a = new FuzzSelector[](1);
        bytes4[] memory s = new bytes4[](1);
        s[0] = this.act.selector;
        a[0] = FuzzSelector(address(this), s);
    }

    function act(uint8 seed, bool fail) external {
        address[] memory active = bank.getActivePerpPools(address(account));
        IntentTypes.Intent memory i = _intent(active.length == 0 ? 2 + uint256(seed) % 7 : active.length);
        i.nonce = nextNonce++;
        if (active.length != 0) {
            i.operation = 2;
            i.legs = new IntentTypes.Leg[](active.length);
            for (uint256 j; j < active.length; j++) {
                int128 size = bank.getPosition(address(account), active[j]).size;
                i.legs[j] = IntentTypes.Leg(active[j], -size, 100e18, 0);
            }
        }
        i.expectedPositionsHash = router.positionsHash(address(account), i.legs);
        bytes32 beforeHash = router.positionsHash(address(account), i.legs);
        if (fail) pools[0].setReject(true);
        try this.executeHandler(i) {}
        catch {
            if (
                router.positionsHash(address(account), i.legs) != beforeHash
                    || router.nonceUsed(address(account), i.epoch, i.nonce)
            ) broken = true;
        }
        pools[0].setReject(false);
    }

    function executeHandler(IntentTypes.Intent calldata intent) external {
        require(msg.sender == address(this));
        _execute(intent);
    }

    function invariant_FailedExecutionCannotLeavePartialChangesOrConsumeNonce() public view {
        require(!broken, "atomicity invariant");
    }

    function invariant_BasketNeverExceedsEightActiveMarkets() public view {
        require(bank.getActivePerpPools(address(account)).length <= 8, "market count");
    }

    function invariant_AccountOwnerAndMarginIsolationRemainIntact() public view {
        require(account.owner() == owner, "owner changed");
        (int256 equity,,,) = bank.getAccountHealth(address(account));
        require(equity >= 0, "unexpected debt");
    }
}
