import React from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import faTimes from '@fortawesome/fontawesome-free-solid/faTimes';
import { ResizableContainer } from 'components';
import { classes } from 'common/util';
import {
  movePanel, panelTitle, removePanel, setLeafActive, updateWeights,
} from 'common/dock';
import styles from './DockWorkspace.module.scss';

// The panel being dragged right now (module-level: drag events
// cross the whole tree, and only one drag can run at a time).
let draggedPanelId = null;

// Renders a dock tree (common/dock): splits become nested
// ResizableContainers, leaves become tab groups. A panel tab can
// be dragged onto any leaf - center joins its tabs, an edge
// splits the leaf in that direction - or closed with its x and
// reopened later from the header / Layouts menu.
class DockWorkspace extends React.Component {
  constructor(props) {
    super(props);
    this.state = { dropLeafId: null, zone: null };
    this.clearDrag = this.clearDrag.bind(this);
  }

  componentDidMount() {
    window.addEventListener('dragend', this.clearDrag);
    window.addEventListener('drop', this.clearDrag);
  }

  componentWillUnmount() {
    window.removeEventListener('dragend', this.clearDrag);
    window.removeEventListener('drop', this.clearDrag);
  }

  clearDrag() {
    draggedPanelId = null;
    if (this.state.dropLeafId) this.setState({ dropLeafId: null, zone: null });
  }

  zoneAt(event, element) {
    const rect = element.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
    const distances = [
      ['left', x], ['right', 1 - x], ['top', y], ['bottom', 1 - y],
    ];
    const [zone, distance] = distances.reduce((a, b) => (b[1] < a[1] ? b : a));
    return distance < 0.25 ? zone : 'center';
  }

  handleDragOver(event, leaf) {
    if (!draggedPanelId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const zone = this.zoneAt(event, event.currentTarget);
    if (this.state.dropLeafId !== leaf.id || this.state.zone !== zone) {
      this.setState({ dropLeafId: leaf.id, zone });
    }
  }

  handleDrop(event, leaf) {
    if (!draggedPanelId) return;
    event.preventDefault();
    const panelId = draggedPanelId;
    const zone = this.zoneAt(event, event.currentTarget);
    this.clearDrag();
    this.props.onChange(movePanel(this.props.tree, panelId, leaf.id, zone));
  }

  renderLeaf(leaf) {
    const { tree, onChange, renderPanel } = this.props;
    const { dropLeafId, zone } = this.state;
    const isDropTarget = dropLeafId === leaf.id && draggedPanelId;
    return (
      <div key={leaf.id} className={styles.leaf}
           onDragOver={event => this.handleDragOver(event, leaf)}
           onDrop={event => this.handleDrop(event, leaf)}
           onDragLeave={event => {
             if (event.currentTarget === event.target && this.state.dropLeafId === leaf.id) {
               this.setState({ dropLeafId: null, zone: null });
             }
           }}>
        <div className={styles.tab_bar}>
          {
            leaf.panels.map(panelId => (
              <div key={panelId}
                   className={classes(styles.tab, leaf.active === panelId && styles.tab_active)}
                   draggable
                   onDragStart={event => {
                     draggedPanelId = panelId;
                     event.dataTransfer.setData('text/plain', panelId);
                     event.dataTransfer.effectAllowed = 'move';
                   }}
                   onDragEnd={this.clearDrag}
                   onClick={() => {
                     if (leaf.active !== panelId) onChange(setLeafActive(tree, leaf.id, panelId));
                   }}>
                <span className={styles.tab_title}>{panelTitle(panelId)}</span>
                <span className={styles.tab_close} title={`Close the ${panelTitle(panelId)} panel`}
                      onClick={event => {
                        event.stopPropagation();
                        const next = removePanel(tree, panelId);
                        if (next) onChange(next);
                      }}>
                  <FontAwesomeIcon fixedWidth icon={faTimes}/>
                </span>
              </div>
            ))
          }
        </div>
        <div className={styles.content}>
          {renderPanel(leaf.active)}
        </div>
        {isDropTarget ? <div className={classes(styles.drop_zone, styles[`zone_${zone}`])}/> : null}
      </div>
    );
  }

  renderNode(node) {
    if (node.kind === 'leaf') return this.renderLeaf(node);
    return (
      <ResizableContainer key={node.id} className={styles.fill}
                          horizontal={node.dir === 'row'}
                          weights={node.weights}
                          onChangeWeights={weights => this.props.onChange(updateWeights(this.props.tree, node.id, weights))}>
        {node.children.map(child => this.renderNode(child))}
      </ResizableContainer>
    );
  }

  render() {
    const { tree, className } = this.props;
    if (!tree) return null;
    return (
      <div className={classes(styles.dock, className)}>
        {this.renderNode(tree)}
      </div>
    );
  }
}

export default DockWorkspace;
