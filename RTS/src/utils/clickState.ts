// Shared state to track whether a unit was clicked
// This allows UnitsLayer to communicate with HexInteraction without prop drilling

export const clickState = {
  unitWasClicked: false,

  setUnitClicked() {
    this.unitWasClicked = true;
  },

  resetClickState() {
    this.unitWasClicked = false;
  },

  wasUnitClicked(): boolean {
    return this.unitWasClicked;
  }
};
