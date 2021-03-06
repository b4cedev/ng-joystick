import { Component, OnInit, AfterViewInit, Input, ViewChild, ElementRef, Inject, Renderer2, OnDestroy, Output } from '@angular/core';
import { DOCUMENT } from '@angular/common';

import { Observable, Subject } from 'rxjs';
import { Subscription } from 'rxjs';
import { fromEvent } from 'rxjs';
import { map, switchMap, takeUntil, tap, publishReplay, refCount, filter, take, distinctUntilChanged } from 'rxjs/operators';
import { merge } from 'rxjs';

import { distance, angle, findCoord, radians, normalizedPosition } from './ng-joystick-utils';

export interface JoystickEvent {
    pointerPos: {
        x: any;
        y: any;
    };
    clampedPos: {
        x: number;
        y: number;
    };
    normalizedPos: {
        x: number;
        y: number;
    };
    force: number;
    pressure: any;
    distance: number;
    angle: {
        radian: number;
        degree: number;
    };
    direction: any;
}

// such constants are calculated once for all
const angle45 = Math.PI / 4;
const angle90 = Math.PI / 2;

@Component({
  selector: 'njk-joystick',
  template: `
    <div class="joystickPad" #joystickPad>
        <div class="joystickHandle" #joystickHandle></div>
    </div>
  `,
  styleUrls: ['./ng-joystick.component.css']
})
export class NgJoystickComponent implements OnInit, AfterViewInit, OnDestroy {
  // Input APIs
  @Input() threshold = 0.1;

  private size: number;
  private startPosition: {x: number, y: number};
  private maxDist = this.size / 2;
  @ViewChild('joystickPad') private joystickPadElement: ElementRef;
  @ViewChild('joystickHandle') private handleElement: ElementRef;
  private handleNativeElement;
  private handleOffset: number;
  private move$: Observable<any>;
  private end$: Observable<any>;

  private joystickMoveSubscription: Subscription;

  private planDirection$: Observable<any>;

  // Output APIs
  @Output() joystickStart$ = new Subject<any>();
  @Output() joystickMove$ = new Subject<JoystickEvent>();
  @Output() joystickRelease$ = new Subject<JoystickEvent>();
  @Output() up$ = new Subject<any>();
  @Output() down$ = new Subject<any>();
  @Output() right$ = new Subject<any>();
  @Output() left$ = new Subject<any>();
  @Output() planDirX$ = new Subject<any>();
  @Output() planDirY$ = new Subject<any>();

  constructor(@Inject(DOCUMENT) private document: any, private renderer: Renderer2) { }

  ngOnInit() {
  }

  ngAfterViewInit() {
    this.handleNativeElement = this.handleElement.nativeElement;
    this.size = this.joystickPadElement.nativeElement.offsetWidth;
    this.handleOffset = this.handleNativeElement.offsetWidth / 2;
    this.maxDist = this.size / 2;
    // console.log('size', this.size, this.maxDist, this.handleOffset);
    this.startPosition = this.calculateStartPosition();
    merge(
        this.buildStream(this.joystickPadElement.nativeElement, 'pointerdown'),
        this.buildStream(this.joystickPadElement.nativeElement, 'mousedown'),
        this.buildStream(this.joystickPadElement.nativeElement, 'touchstart'),
    ).subscribe(this.joystickStart$);
    this.end$ = merge(
        this.buildStream(this.document, 'pointerup'),
        this.buildStream(this.document, 'pointercancel'),
        this.buildStream(this.document, 'mouseup'),
        this.buildStream(this.document, 'touchend'),
        this.buildStream(this.document, 'touchcancel'),
    );
    this.move$ = merge(
        this.buildStream(this.document, 'pointermove'),
        this.buildStream(this.document, 'mousemove'),
        this.buildStream(this.document, 'touchmove'),
    );

    // this.joystickMove$ = this.buildJoystickMove();
    this.buildJoystickMove().subscribe(this.joystickMove$);
    this.buildJoystickRelease().subscribe(this.joystickRelease$);

    // we need to subscribe since it is joystickMove$ Observable which controls the position
    // of the joystick on the UI
    this.joystickMoveSubscription = this.joystickMove$.subscribe();

    this.joystickMove$.pipe(map(joystickEvent => joystickEvent.direction.dirX)).subscribe(this.planDirX$);
    this.joystickMove$.pipe(map(joystickEvent => joystickEvent.direction.dirY)).subscribe(this.planDirY$);

    this.planDirection$ = this.joystickMove$.pipe(map(joystickEvent => joystickEvent.direction.planDir));
    this.planDirection$.pipe(distinctUntilChanged(), filter(d => d === 'up')).subscribe(this.up$);
    this.planDirection$.pipe(distinctUntilChanged(), filter(d => d === 'down')).subscribe(this.down$);
    this.planDirection$.pipe(distinctUntilChanged(), filter(d => d === 'right')).subscribe(this.right$);
    this.planDirection$.pipe(distinctUntilChanged(), filter(d => d === 'left')).subscribe(this.left$);

  }

  ngOnDestroy() {
    this.joystickMoveSubscription.unsubscribe();
  }

  private calculateStartPosition(): {x: number, y: number} {
    let el = this.joystickPadElement.nativeElement;
    let x = this.maxDist;
    let y = this.maxDist;
    while ( el && !isNaN( el.offsetLeft ) && !isNaN( el.offsetTop ) ) {
      x += el.offsetLeft - el.scrollLeft;
      y += el.offsetTop - el.scrollTop;
      el = el.offsetParent;
    }
    // console.log('calculateStartPosition()', x, y);
    return {x, y};
  }

  private buildStream(element, eventName: string) {
    return fromEvent(element, eventName)
    .pipe(
        map(event => this.prepareEvent(event)),
    );
  }

  // Observable which notifies the position - it is shared
  private buildJoystickMove() {
    return this.joystickStart$
    .pipe(
        tap(() => this.joystickActivated()),
        switchMap(() => this.moveUntilJoystickReleased()),
        map(event => this.buildJoystickEvent(event)),
        tap(joystickEvent => this.showJoystickHandleInNewPosition(joystickEvent.clampedPos)),
        filter(event => event.direction),
        // 'publishReplay' and 'refCount' ensure that there is only one subscription running
        // which means that `setHandlePosition` is run only once independently on how many clients
        // subscribe to this Observable
        publishReplay(1),
        refCount(),
    );
  }
  private moveUntilJoystickReleased() {
      return this.move$
      .pipe(
          takeUntil(this.end$
              .pipe(
                  tap(() => this.joystickReleased())
              )
          ),
      );
  }
  private buildJoystickRelease() {
    return this.joystickStart$
    .pipe(
        // we need to take only one notification of end$ and then terminate because
        // joystickRelease$ has to emit only once after the joystick has been activated by clicking on the handle
        switchMap(() => this.end$.pipe(take(1))),
        map(event => this.buildJoystickEvent(event, true)),
        // 'publishReplay' and 'refCount' ensure that there is only one subscription running
        // which means that `setHandlePosition` is run only once independently on how many clients
        // subscribe to this Observable
        publishReplay(1),
        refCount(),
    );
  }

  private prepareEvent(event) {
    event.preventDefault();
    return event.type.match(/^touch/) ? event.changedTouches.item(0) : event;
  }

  private buildJoystickEvent(event, release = false) {
    const pointerPos = {
        x: release ? this.startPosition.x : event.clientX,
        y: release ? this.startPosition.y : (event.clientY - this.handleOffset)
    };
    let clampedPos: {
        x: number,
        y: number
    };

    let dist = distance(pointerPos, this.startPosition);
    const eventAngle = angle(pointerPos, this.startPosition);

    // If distance is bigger than joystick's size
    // we clamp the position.
    if (dist > this.maxDist) {
        dist = this.maxDist;
        clampedPos = findCoord(this.startPosition, dist, eventAngle);
    } else {
        clampedPos = pointerPos;
    }
    const normalizedPos = normalizedPosition(this.maxDist, clampedPos, this.startPosition);

    const force = dist / this.size;
    const rAngle = radians(180 - eventAngle);
    // Compute the direction's datas.
    let direction;
    if (force > this.threshold) {
        direction = this.computeDirection(rAngle);
    }

    // Prepare event's data.
    const moveEvent: JoystickEvent = {
        pointerPos,
        clampedPos,
        normalizedPos,
        force,
        pressure: event.force || event.pressure || event.webkitForce || 0,
        distance: dist,
        angle: {
            radian: rAngle,
            degree: 180 - eventAngle
        },
        direction
    };

    return moveEvent;
  }

  private showJoystickHandleInNewPosition(clampedPos) {
    const xPosition = Math.round((clampedPos.x - this.startPosition.x + this.maxDist - this.handleOffset) * 100) / 100 + 'px';
    const yPosition = Math.round((clampedPos.y - this.startPosition.y + this.maxDist - this.handleOffset) * 100) / 100 + 'px';

    this.renderer.setStyle(this.handleNativeElement, 'left', xPosition);
    this.renderer.setStyle(this.handleNativeElement, 'top', yPosition);
  }

  private computeDirection(radianAngle) {
    let direction, directionX, directionY;

    // Plan direction
    //     \  UP /
    //      \   /
    // LEFT       RIGHT
    //      /   \
    //     /DOWN \
    //
    if (
        radianAngle > angle45 &&
        radianAngle < (angle45 * 3)
    ) {
        direction = 'up';
    } else if (
        // radianAngle > -angle45 &&
        radianAngle > (angle45 * 3) &&
        radianAngle <= (angle45 * 5)
    ) {
        direction = 'left';
    } else if (
        radianAngle > (angle45 * 5) &&
        radianAngle <= (angle45 * 7)
    ) {
        direction = 'down';
    } else {
        direction = 'right';
    }

    // Plain direction
    //    UP                 |
    // _______               | RIGHT
    //                  LEFT |
    //   DOWN                |
    if (radianAngle > angle90 && radianAngle < (angle90 * 3)) {
        directionX = 'left';
    } else {
        directionX = 'right';
    }

    if (radianAngle < (angle90 * 2)) {
        directionY = 'up';
    } else {
        directionY = 'down';
    }

    const newDirectionInfo = {dirX: directionX, dirY: directionY, planDir: direction};

    return newDirectionInfo;
  }

  private joystickActivated() {
    this.renderer.removeStyle(this.handleNativeElement, 'transition');
  }

  private joystickReleased() {
    this.renderer.setStyle(this.handleNativeElement, 'transition', 'top 250ms, left 250ms');
    this.renderer.setStyle(this.handleNativeElement, 'left', this.maxDist - this.handleOffset + 'px');
    this.renderer.setStyle(this.handleNativeElement, 'top', this.maxDist - this.handleOffset + 'px');
  }

}

