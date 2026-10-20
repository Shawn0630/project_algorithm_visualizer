import React from 'react';
import { connect } from 'react-redux';
import { classes } from 'common/util';
import styles from './NavTabContainer.module.scss';

class NavTabContainer extends React.Component {
    render() {
      const { className, children, onSelect, selected } = this.props;
  
      return (
        <div className={classes(styles.tab_container, className)}>
          <div className={styles.tab_bar}>
            <div className={classes(styles.title, styles.fake)}/>
                <div className={classes(styles.title, selected == 'Algorithm' ? styles.selected : null)} key={0} onClick={() => onSelect('Algorithm')}>
                 Algorithm
                </div>
                <div className={classes(styles.title, selected == 'Leetcode' ? styles.selected : null)} key={0} onClick={() => onSelect('Leetcode')}>
                 Leetcode
                </div>
          </div>
          <div className={styles.content}>
            {children}
          </div>
        </div>
      );
    }
  }
  
  export default connect(({ current, env }) => ({ current, env }))(
    NavTabContainer,
  );